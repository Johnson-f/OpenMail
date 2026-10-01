import Foundation
import Network
import os

extension NWListener {
    /// Starts a listener bound to 127.0.0.1 on a free port and returns once it's accepting connections.
    static func startOnLoopback(queue: DispatchQueue) async throws -> (NWListener, UInt16) {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let resumed = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { state in
                let result: Result<UInt16, any Error>?
                switch state {
                case .ready: result = listener.port.map { .success($0.rawValue) } ?? .failure(URLError(.cannotFindHost))
                case let .failed(error): result = .failure(error)
                default: result = nil
                }
                guard let result, resumed.withLock({ let first = !$0; $0 = true; return first }) else { return }
                continuation.resume(with: result)
            }
            listener.newConnectionHandler = { $0.cancel() }
            listener.start(queue: queue)
        }
        return (listener, port)
    }
}

/// A minimal HTTP/1.1 request, enough for local OAuth callbacks and MCP calls.
struct HTTPRequest: Sendable {
    var method: String
    var target: String
    var headers: [String: String]
    var body: Data

    func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }

    /// Parses a complete request, or returns nil if more bytes are needed.
    static func parse(_ data: Data) -> HTTPRequest? {
        guard let headerEnd = data.firstRange(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: data[data.startIndex..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = headers["content-length"].flatMap(Int.init) ?? 0
        let body = data[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        return HTTPRequest(method: String(requestLine[0]), target: String(requestLine[1]), headers: headers, body: Data(body.prefix(length)))
    }
}

struct HTTPResponse: Sendable {
    var status: Int
    var reason: String
    var contentType: String?
    var body: Data = Data()

    var serialized: Data {
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
        if let contentType { head += "Content-Type: \(contentType)\r\n" }
        return Data((head + "\r\n").utf8) + body
    }
}

extension NWConnection {
    /// Reads one HTTP request (up to `limit` bytes), lets `respond` build the reply, then closes the connection.
    func serveOneRequest(queue: DispatchQueue, limit: Int = 4 * 1024 * 1024, respond: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) {
        start(queue: queue)
        receiveRequest(buffer: Data(), limit: limit, respond: respond)
    }

    private func receiveRequest(buffer: Data, limit: Int, respond: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) {
        receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [self] data, _, isComplete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = HTTPRequest.parse(buffer) {
                Task {
                    let response = await respond(request)
                    self.send(content: response.serialized, completion: .contentProcessed { _ in self.cancel() })
                }
            } else if error != nil || isComplete || buffer.count > limit {
                cancel()
            } else {
                receiveRequest(buffer: buffer, limit: limit, respond: respond)
            }
        }
    }
}
