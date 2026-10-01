import Foundation
import Network
import os

/// Receives the OAuth redirect on 127.0.0.1, as Google requires for desktop clients.
final class LoopbackServer: Sendable {
    let port: UInt16
    private let listener: NWListener
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    private struct State {
        var result: Result<[String: String], any Error>?
        var continuation: CheckedContinuation<[String: String], any Error>?
    }

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    static func start() async throws -> LoopbackServer {
        let queue = DispatchQueue(label: "openmail.oauth-loopback")
        let (listener, port) = try await NWListener.startOnLoopback(queue: queue)
        let server = LoopbackServer(listener: listener, port: port)
        listener.newConnectionHandler = { [weak server] connection in
            guard let server else { return connection.cancel() }
            connection.serveOneRequest(queue: queue) { request in server.respond(to: request) }
        }
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

    private func respond(to request: HTTPRequest) -> HTTPResponse {
        guard request.method == "GET", let params = Self.queryParameters(target: request.target),
              params["code"] != nil || params["error"] != nil else {
            return HTTPResponse(status: 404, reason: "Not Found")
        }
        finish(.success(params))
        return HTTPResponse(status: 200, reason: "OK", contentType: "text/html; charset=utf-8", body: Data(Self.successPage.utf8))
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

    static func queryParameters(target: String) -> [String: String]? {
        guard let components = URLComponents(string: "http://127.0.0.1" + target) else { return nil }
        return Dictionary(
            (components.queryItems ?? []).map { ($0.name, $0.value ?? "") },
            uniquingKeysWith: { first, _ in first }
        )
    }

    private static let successPage = """
        <!doctype html><html><body style="font: 15px -apple-system; text-align: center; padding-top: 80px">\
        <h2>You're signed in to OpenMail</h2><p>You can close this tab and return to the app.</p></body></html>
        """
}
