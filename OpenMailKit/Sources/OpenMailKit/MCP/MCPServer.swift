import Foundation
import Network

/// Serves JSON-RPC over MCP's Streamable HTTP transport on 127.0.0.1, guarded by a random bearer token.
final class MCPServer: Sendable {
    let port: UInt16
    let token: String
    private let listener: NWListener

    var url: URL { URL(string: "http://127.0.0.1:\(port)/mcp")! }

    private init(listener: NWListener, port: UInt16, token: String) {
        self.listener = listener
        self.port = port
        self.token = token
    }

    static func start(handler: @escaping @Sendable (JSONValue) async -> JSONValue?) async throws -> MCPServer {
        let queue = DispatchQueue(label: "openmail.mcp")
        let (listener, port) = try await NWListener.startOnLoopback(queue: queue)
        let token = PKCE.randomVerifier()
        listener.newConnectionHandler = { connection in
            connection.serveOneRequest(queue: queue) { request in
                await respond(to: request, token: token, handler: handler)
            }
        }
        return MCPServer(listener: listener, port: port, token: token)
    }

    func stop() {
        listener.cancel()
    }

    private static func respond(
        to request: HTTPRequest,
        token: String,
        handler: @Sendable (JSONValue) async -> JSONValue?
    ) async -> HTTPResponse {
        guard request.target.hasPrefix("/mcp") else { return HTTPResponse(status: 404, reason: "Not Found") }
        guard request.header("authorization") == "Bearer \(token)" else { return HTTPResponse(status: 401, reason: "Unauthorized") }
        guard request.method == "POST" else { return HTTPResponse(status: 405, reason: "Method Not Allowed") }
        guard let message = try? JSONValue.parse(request.body) else {
            return json(["jsonrpc": "2.0", "id": .null, "error": ["code": -32700, "message": "Parse error"]])
        }
        let reply: JSONValue?
        if case let .array(batch) = message {
            var replies: [JSONValue] = []
            for item in batch {
                if let response = await handler(item) { replies.append(response) }
            }
            reply = replies.isEmpty ? nil : .array(replies)
        } else {
            reply = await handler(message)
        }
        guard let reply else { return HTTPResponse(status: 202, reason: "Accepted") }
        return json(reply)
    }

    private static func json(_ value: JSONValue) -> HTTPResponse {
        HTTPResponse(status: 200, reason: "OK", contentType: "application/json", body: (try? value.encoded()) ?? Data())
    }
}

struct ActiveTurn: Sendable {
    var context: AssistantContext
    var emit: @Sendable (AssistantEvent) -> Void
}

/// Answers MCP requests by exposing the mail toolbox. Notifications get no reply.
struct MCPToolHandler: Sendable {
    let toolbox: MailToolbox
    let activeTurn: @Sendable () -> ActiveTurn?

    func handle(_ message: JSONValue) async -> JSONValue? {
        guard let id = message["id"] else { return nil }
        let params = message["params"] ?? [:]
        switch message["method"]?.stringValue {
        case "initialize":
            return result(id, [
                "protocolVersion": params["protocolVersion"] ?? "2025-06-18",
                "capabilities": ["tools": [:]],
                "serverInfo": ["name": "openmail", "version": "1.0"],
            ])
        case "ping":
            return result(id, [:])
        case "tools/list":
            return result(id, ["tools": .array(AssistantPrompt.tools.map {
                ["name": .string($0.name), "description": .string($0.description), "inputSchema": $0.inputSchema]
            })])
        case "tools/call":
            guard let turn = activeTurn() else {
                return toolResult(id, text: "OpenMail isn't handling a request right now.", isError: true)
            }
            let output = await toolbox.call(
                params["name"]?.stringValue ?? "",
                input: params["arguments"] ?? [:],
                context: turn.context,
                emit: turn.emit
            )
            return toolResult(id, text: output.text, isError: output.isError)
        default:
            return ["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]]
        }
    }

    private func toolResult(_ id: JSONValue, text: String, isError: Bool) -> JSONValue {
        result(id, ["content": [["type": "text", "text": .string(text)]], "isError": .bool(isError)])
    }

    private func result(_ id: JSONValue, _ value: JSONValue) -> JSONValue {
        ["jsonrpc": "2.0", "id": id, "result": value]
    }
}
