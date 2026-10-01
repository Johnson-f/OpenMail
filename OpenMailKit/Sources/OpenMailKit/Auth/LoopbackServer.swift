import Foundation
import Network
import os

/// Receives the OAuth redirect on 127.0.0.1, as Google requires for desktop clients.
final class LoopbackServer: Sendable {
    let port: UInt16
    private let listener: NWListener
    private let queue: DispatchQueue
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    private struct State {
        var result: Result<[String: String], any Error>?
        var continuation: CheckedContinuation<[String: String], any Error>?
    }

    private init(listener: NWListener, queue: DispatchQueue, port: UInt16) {
        self.listener = listener
        self.queue = queue
        self.port = port
    }

    static func start() async throws -> LoopbackServer {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "openmail.oauth-loopback")

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

        let server = LoopbackServer(listener: listener, queue: queue, port: port)
        listener.newConnectionHandler = { [weak server] connection in server?.handle(connection) }
        return server
    }

    /// Waits for the browser to hit the redirect URI and returns its query parameters.
    func waitForCallback() async throws -> [String: String] {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let ready = state.withLock { state -> Result<[String: String], any Error>? in
                    if let result = state.result { return result }
                    state.continuation = continuation
                    return nil
                }
                if let ready { continuation.resume(with: ready) }
            }
        } onCancel: {
            finish(.failure(CancellationError()))
        }
    }

    func stop() {
        listener.cancel()
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self else { return connection.cancel() }
            let params = data.flatMap(Self.queryParameters)
            let isCallback = params.map { $0["code"] != nil || $0["error"] != nil } ?? false
            let response = isCallback ? Self.successResponse : Self.notFoundResponse
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            if isCallback, let params { finish(.success(params)) }
        }
    }

    private func finish(_ result: Result<[String: String], any Error>) {
        let continuation = state.withLock { state -> CheckedContinuation<[String: String], any Error>? in
            guard state.result == nil else { return nil }
            state.result = result
            defer { state.continuation = nil }
            return state.continuation
        }
        continuation?.resume(with: result)
    }

    static func queryParameters(fromRequest data: Data) -> [String: String]? {
        guard let requestLine = String(decoding: data, as: UTF8.self).split(separator: "\r\n").first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET",
              let components = URLComponents(string: "http://127.0.0.1" + parts[1]) else { return nil }
        return Dictionary(
            (components.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { first, _ in first }
        )
    }

    private static let successResponse = """
        HTTP/1.1 200 OK\r
        Content-Type: text/html; charset=utf-8\r
        Connection: close\r
        \r
        <!doctype html><html><body style="font: 15px -apple-system; text-align: center; padding-top: 80px">\
        <h2>You're signed in to OpenMail</h2><p>You can close this tab and return to the app.</p></body></html>
        """

    private static let notFoundResponse = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
}
