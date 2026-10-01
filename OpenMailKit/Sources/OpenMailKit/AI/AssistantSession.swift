import Foundation

public struct CitationTarget: Hashable, Sendable {
    public var accountID: String
    public var messageID: String
    public var threadID: String

    public var threadRef: ThreadRef { ThreadRef(accountID: accountID, threadID: threadID) }
}

public struct DraftProposal: Hashable, Sendable, Identifiable {
    public let id = UUID()
    public var draft: OutgoingMessage
}

public struct AssistantContext: Sendable {
    public var accountIDs: [String]
    public var viewing: ThreadRef?

    public init(accountIDs: [String], viewing: ThreadRef?) {
        self.accountIDs = accountIDs
        self.viewing = viewing
    }
}

public enum AssistantEvent: Sendable {
    case text(String)
    case activity(String)
    case draft(DraftProposal)
    case citations([String: CitationTarget])
}

public protocol AssistantBackend: Sendable {
    func send(_ text: String, context: AssistantContext) -> AsyncThrowingStream<AssistantEvent, any Error>
    func close() async
}

public enum AssistantError: Error, LocalizedError {
    case refused
    case truncated
    case tooManySteps

    public var errorDescription: String? {
        switch self {
        case .refused: "Claude declined to answer this request."
        case .truncated: "The response was cut off before it finished. Try asking a narrower question."
        case .tooManySteps: "The assistant took too many steps without finishing. Try rephrasing the question."
        }
    }
}

/// One assistant conversation over the Claude API. History is append-only so Claude's thinking blocks stay valid across turns.
public actor AssistantSession: AssistantBackend {
    static let model = "claude-sonnet-5-5"
    private static let maxSteps = 12

    private let client: ClaudeClient
    private let toolbox: MailToolbox
    private var messages: [JSONValue] = []

    init(client: ClaudeClient, toolbox: MailToolbox) {
        self.client = client
        self.toolbox = toolbox
    }

    public func close() {}

    public nonisolated func send(_ text: String, context: AssistantContext) -> AsyncThrowingStream<AssistantEvent, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await self.run(text, context: context, events: continuation)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ text: String, context: AssistantContext, events: AsyncThrowingStream<AssistantEvent, any Error>.Continuation) async throws {
        let checkpoint = messages.count
        do {
            messages.append(["role": "user", "content": .array([
                ["type": "text", "text": .string(try await toolbox.contextNote(context))],
                ["type": "text", "text": .string(text)],
            ])])
            for _ in 0..<Self.maxSteps {
                let response = try await streamTurn(events: events)
                let content = Self.replayableContent(response.content)
                switch response.stopReason {
                case "refusal":
                    throw AssistantError.refused
                case "max_tokens":
                    throw AssistantError.truncated
                case "tool_use":
                    messages.append(["role": "assistant", "content": .array(content)])
                    var results: [JSONValue] = []
                    for block in content where block["type"]?.stringValue == "tool_use" {
                        results.append(await runTool(block, invalidInputs: response.invalidToolInputs, context: context, events: events))
                    }
                    messages.append(["role": "user", "content": .array(results)])
                default:
                    if !content.isEmpty { messages.append(["role": "assistant", "content": .array(content)]) }
                    return
                }
            }
            throw AssistantError.tooManySteps
        } catch {
            // Dropping the unfinished turn keeps the history valid for the next request; earlier turns are untouched.
            messages.removeSubrange(checkpoint...)
            throw error
        }
    }

    private func streamTurn(events: AsyncThrowingStream<AssistantEvent, any Error>.Continuation) async throws -> ClaudeResponse {
        let request = ClaudeRequest(
            model: Self.model,
            maxTokens: 64_000,
            effort: "medium",
            system: AssistantPrompt.system,
            tools: AssistantPrompt.apiTools,
            messages: messages
        )
        for try await event in client.stream(request) {
            switch event {
            case let .textDelta(text): events.yield(.text(text))
            case .toolUseStarted: break
            case let .completed(response): return response
            }
        }
        throw ClaudeError.stream("The response ended unexpectedly.")
    }

    /// After a mid-response fallback, blocks the declined model produced before the switch can't be replayed.
    static func replayableContent(_ content: [JSONValue]) -> [JSONValue] {
        guard let boundary = content.lastIndex(where: { $0["type"]?.stringValue == "fallback" }) else { return content }
        let dropped: Set<String> = ["thinking", "redacted_thinking", "tool_use", "server_tool_use"]
        return content.enumerated().compactMap { index, block in
            index < boundary && dropped.contains(block["type"]?.stringValue ?? "") ? nil : block
        }
    }

    private func runTool(
        _ block: JSONValue,
        invalidInputs: [String: String],
        context: AssistantContext,
        events: AsyncThrowingStream<AssistantEvent, any Error>.Continuation
    ) async -> JSONValue {
        let id = block["id"]?.stringValue ?? ""
        let output: MailToolbox.Output
        if let raw = invalidInputs[id] {
            let payload = (try? JSONValue.object(["INVALID_JSON": .string(raw)]).encoded()) ?? Data()
            output = MailToolbox.Output(text: String(decoding: payload, as: UTF8.self), isError: true)
        } else {
            output = await toolbox.call(
                block["name"]?.stringValue ?? "",
                input: block["input"] ?? [:],
                context: context,
                emit: { events.yield($0) }
            )
        }
        var result: JSONValue = ["type": "tool_result", "tool_use_id": .string(id), "content": .string(output.text)]
        if output.isError { result["is_error"] = true }
        return result
    }
}

