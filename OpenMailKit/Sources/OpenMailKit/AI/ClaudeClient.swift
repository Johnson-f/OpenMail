import Foundation

public enum ClaudeError: Error, Equatable, LocalizedError {
    case missingAPIKey
    case http(status: Int, message: String)
    case stream(String)

    public var errorDescription: String? {
        switch self {
        case .missingAPIKey: "Add an Anthropic API key in Settings to use the assistant."
        case let .http(status, message): "Claude API error \(status): \(message)"
        case let .stream(message): "Claude stream error: \(message)"
        }
    }
}

public struct ClaudeRequest: Sendable {
    public var model: String
    public var maxTokens: Int
    public var effort: String
    public var system: String
    public var tools: [JSONValue]
    public var messages: [JSONValue]
}

public struct ClaudeResponse: Sendable {
    public var content: [JSONValue]
    public var stopReason: String?
    public var model: String?
    /// Raw `partial_json` for tool calls whose streamed input wasn't valid JSON, keyed by tool use ID.
    public var invalidToolInputs: [String: String]
}

public enum ClaudeStreamEvent: Sendable {
    case textDelta(String)
    case toolUseStarted(name: String)
    case completed(ClaudeResponse)
}

public protocol LineStreamingTransport: Sendable {
    /// Sends the request and streams the response body line by line. Throws for non-2xx responses.
    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, any Error>
}

public struct HTTPStatusError: Error {
    public let status: Int
    public let body: String
    public let retryAfter: TimeInterval?
}

extension URLSessionTransport: LineStreamingTransport {
    public func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, any Error> {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            throw HTTPStatusError(
                status: http.statusCode,
                body: String(decoding: body, as: UTF8.self),
                retryAfter: http.value(forHTTPHeaderField: "retry-after").flatMap(TimeInterval.init)
            )
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await line in bytes.lines { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

public struct ClaudeClient: Sendable {
    private static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    private static let maxAttempts = 3

    let apiKey: String
    let transport: any LineStreamingTransport

    public init(apiKey: String, transport: any LineStreamingTransport = URLSessionTransport()) {
        self.apiKey = apiKey
        self.transport = transport
    }

    public func stream(_ request: ClaudeRequest) -> AsyncThrowingStream<ClaudeStreamEvent, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let lines = try await openStream(request)
                    var assembler = ResponseAssembler()
                    for try await line in lines {
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        let event = try JSONValue.parse(Data(payload.utf8))
                        for output in try assembler.apply(event) { continuation.yield(output) }
                    }
                    continuation.yield(.completed(assembler.response))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func openStream(_ request: ClaudeRequest) async throws -> AsyncThrowingStream<String, any Error> {
        let urlRequest = try makeURLRequest(request)
        for attempt in 1...Self.maxAttempts {
            do {
                return try await transport.lines(for: urlRequest)
            } catch let error as HTTPStatusError where Self.isRetryable(error.status) && attempt < Self.maxAttempts {
                try await Task.sleep(for: .seconds(error.retryAfter ?? pow(2, Double(attempt))))
            } catch let error as HTTPStatusError {
                throw ClaudeError.http(status: error.status, message: Self.errorMessage(error.body))
            }
        }
        throw ClaudeError.http(status: 0, message: "Request failed after \(Self.maxAttempts) attempts")
    }

    func makeURLRequest(_ request: ClaudeRequest) throws -> URLRequest {
        var urlRequest = URLRequest(url: Self.endpoint)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 600
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        let body: JSONValue = [
            "model": .string(request.model),
            "max_tokens": .number(Double(request.maxTokens)),
            "stream": true,
            "system": .string(request.system),
            "tools": .array(request.tools),
            "messages": .array(request.messages),
            "output_config": ["effort": .string(request.effort)],
            "cache_control": ["type": "ephemeral"],
            // Re-runs a request that a safety classifier declines on Anthropic's recommended fallback model.
            "fallbacks": "default",
        ]
        urlRequest.httpBody = try body.encoded()
        return urlRequest
    }

    /// Confirms the key works without generating tokens by fetching the assistant model's metadata.
    func validateKey(using transport: any HTTPTransport) async throws {
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/models/\(AssistantSession.model)")!)
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        let (data, response) = try await transport.send(request)
        guard response.statusCode == 200 else {
            throw ClaudeError.http(status: response.statusCode, message: Self.errorMessage(String(decoding: data, as: UTF8.self)))
        }
    }

    private static func isRetryable(_ status: Int) -> Bool {
        status == 429 || status == 529 || (500..<600).contains(status)
    }

    private static func errorMessage(_ body: String) -> String {
        (try? JSONValue.parse(Data(body.utf8)))?["error"]?["message"]?.stringValue ?? body
    }
}

/// Rebuilds the final message from server-sent events, keeping every block's fields intact for replay.
struct ResponseAssembler {
    private var blocks: [Int: JSONValue] = [:]
    private var partialJSON: [Int: String] = [:]
    private var stopReason: String?
    private var model: String?
    private var invalidToolInputs: [String: String] = [:]

    var response: ClaudeResponse {
        ClaudeResponse(
            content: blocks.keys.sorted().compactMap { blocks[$0] },
            stopReason: stopReason,
            model: model,
            invalidToolInputs: invalidToolInputs
        )
    }

    mutating func apply(_ event: JSONValue) throws -> [ClaudeStreamEvent] {
        switch event["type"]?.stringValue {
        case "message_start":
            model = event["message"]?["model"]?.stringValue
        case "content_block_start":
            guard let index = event["index"]?.intValue, let block = event["content_block"] else { break }
            blocks[index] = block
            if block["type"]?.stringValue == "tool_use" {
                partialJSON[index] = ""
                return [.toolUseStarted(name: block["name"]?.stringValue ?? "")]
            }
        case "content_block_delta":
            guard let index = event["index"]?.intValue, let delta = event["delta"] else { break }
            return applyDelta(delta, at: index)
        case "content_block_stop":
            guard let index = event["index"]?.intValue, let raw = partialJSON.removeValue(forKey: index) else { break }
            finishToolInput(raw, at: index)
        case "message_delta":
            if let reason = event["delta"]?["stop_reason"]?.stringValue { stopReason = reason }
        case "error":
            throw ClaudeError.stream(event["error"]?["message"]?.stringValue ?? "unknown error")
        default:
            break
        }
        return []
    }

    private mutating func applyDelta(_ delta: JSONValue, at index: Int) -> [ClaudeStreamEvent] {
        switch delta["type"]?.stringValue {
        case "text_delta":
            let text = delta["text"]?.stringValue ?? ""
            append(text, to: "text", at: index)
            return [.textDelta(text)]
        case "input_json_delta":
            partialJSON[index, default: ""] += delta["partial_json"]?.stringValue ?? ""
        case "thinking_delta":
            append(delta["thinking"]?.stringValue ?? "", to: "thinking", at: index)
        case "signature_delta":
            append(delta["signature"]?.stringValue ?? "", to: "signature", at: index)
        default:
            break
        }
        return []
    }

    private mutating func append(_ text: String, to field: String, at index: Int) {
        let existing = blocks[index]?[field]?.stringValue ?? ""
        blocks[index]?[field] = .string(existing + text)
    }

    private mutating func finishToolInput(_ raw: String, at index: Int) {
        let source = raw.isEmpty ? "{}" : raw
        if let input = try? JSONValue.parse(Data(source.utf8)), case .object = input {
            blocks[index]?["input"] = input
        } else {
            blocks[index]?["input"] = .object([:])
            if let id = blocks[index]?["id"]?.stringValue { invalidToolInputs[id] = raw }
        }
    }
}
