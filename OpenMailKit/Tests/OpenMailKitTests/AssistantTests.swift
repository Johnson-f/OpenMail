import Foundation
@testable import OpenMailKit
import os
import Testing

/// Replays scripted SSE responses, one per request, and records each request body.
final class ScriptedClaude: LineStreamingTransport {
    private let state: OSAllocatedUnfairLock<(responses: [[JSONValue]], requests: [JSONValue])>

    init(_ responses: [[JSONValue]]) {
        state = OSAllocatedUnfairLock(uncheckedState: (responses, []))
    }

    var requests: [JSONValue] { state.withLockUnchecked { $0.requests } }

    func lines(for request: URLRequest) async throws -> AsyncThrowingStream<String, any Error> {
        let body = try JSONValue.parse(request.httpBody ?? Data())
        let events = state.withLockUnchecked { state -> [JSONValue] in
            state.requests.append(body)
            return state.responses.isEmpty ? [] : state.responses.removeFirst()
        }
        let lines = try events.map { "data: " + String(decoding: try $0.encoded(), as: UTF8.self) }
        return AsyncThrowingStream { continuation in
            for line in lines {
                continuation.yield("event: x")
                continuation.yield(line)
            }
            continuation.finish()
        }
    }
}

enum SSE {
    static func message(_ blocks: [[JSONValue]], stopReason: String) -> [JSONValue] {
        var events: [JSONValue] = [["type": "message_start", "message": ["model": "claude-sonnet-5-5"]]]
        for (index, block) in blocks.enumerated() {
            events += block.map { event in
                var event = event
                event["index"] = .number(Double(index))
                return event
            }
        }
        events.append(["type": "message_delta", "delta": ["stop_reason": .string(stopReason)]])
        events.append(["type": "message_stop"])
        return events
    }

    static func thinking(_ signature: String) -> [JSONValue] {
        [
            ["type": "content_block_start", "content_block": ["type": "thinking", "thinking": ""]],
            ["type": "content_block_delta", "delta": ["type": "signature_delta", "signature": .string(signature)]],
            ["type": "content_block_stop"],
        ]
    }

    static func text(_ parts: String...) -> [JSONValue] {
        [["type": "content_block_start", "content_block": ["type": "text", "text": ""]]]
            + parts.map { ["type": "content_block_delta", "delta": ["type": "text_delta", "text": .string($0)]] }
            + [["type": "content_block_stop"]]
    }

    static func toolUse(id: String, name: String, inputFragments: [String]) -> [JSONValue] {
        [["type": "content_block_start", "content_block": ["type": "tool_use", "id": .string(id), "name": .string(name), "input": [:]]]]
            + inputFragments.map { ["type": "content_block_delta", "delta": ["type": "input_json_delta", "partial_json": .string($0)]] }
            + [["type": "content_block_stop"]]
    }
}

struct ResponseAssemblerTests {
    @Test func rebuildsBlocksIncludingSignaturesAndToolInput() throws {
        var assembler = ResponseAssembler()
        let events = SSE.message([
            SSE.thinking("sig-abc"),
            SSE.text("Hello", " there"),
            SSE.toolUse(id: "tu1", name: "search_mail", inputFragments: ["{\"query\": \"de", "posit\"}"]),
        ], stopReason: "tool_use")
        for event in events { _ = try assembler.apply(event) }
        let response = assembler.response
        #expect(response.stopReason == "tool_use")
        #expect(response.content[0] == ["type": "thinking", "thinking": "", "signature": "sig-abc"])
        #expect(response.content[1]["text"] == "Hello there")
        #expect(response.content[2]["input"] == ["query": "deposit"])
        #expect(response.invalidToolInputs.isEmpty)
    }

    @Test func reportsInvalidToolInput() throws {
        var assembler = ResponseAssembler()
        for event in SSE.message([SSE.toolUse(id: "tu1", name: "search_mail", inputFragments: ["{\"query\": "])], stopReason: "tool_use") {
            _ = try assembler.apply(event)
        }
        #expect(assembler.response.invalidToolInputs == ["tu1": "{\"query\": "])
    }

    @Test func dropsDeclinedBlocksBeforeFallbackBoundary() {
        let content: [JSONValue] = [
            ["type": "thinking", "thinking": "", "signature": "s"],
            ["type": "text", "text": "partial"],
            ["type": "fallback", "from": ["model": "a"], "to": ["model": "b"]],
            ["type": "thinking", "thinking": "", "signature": "t"],
            ["type": "text", "text": "rest"],
        ]
        let replayable = AssistantSession.replayableContent(content)
        #expect(replayable.map { $0["type"]?.stringValue } == ["text", "fallback", "thinking", "text"])
    }
}

struct AssistantSessionTests {
    let gmail = FakeGmail()
    let store: MailStore
    let accountID = "me@example.com"

    init() async throws {
        store = try MailStore.inMemory()
        gmail.add(Fixtures.message(id: "m1", thread: "t1", from: "Landlord <ll@example.com>", subject: "Your flat", body: "The deposit will be returned next week."), recordHistory: false)
        try await store.saveAccount(Account(id: accountID, historyID: "1", messagesTotal: 1))
        try await AccountSync(accountID: accountID, gmail: gmail, store: store).backfill()
    }

    private func session(_ claude: ScriptedClaude) -> AssistantSession {
        AssistantSession(
            client: ClaudeClient(apiKey: "test", transport: claude),
            toolbox: MailToolbox(store: store, search: MailSearch(store: store, vectors: VectorIndex(store: store), embeddings: nil))
        )
    }

    private func collect(_ stream: AsyncThrowingStream<AssistantEvent, any Error>) async throws -> (text: String, events: [AssistantEvent]) {
        var text = ""
        var events: [AssistantEvent] = []
        for try await event in stream {
            if case let .text(delta) = event { text += delta }
            events.append(event)
        }
        return (text, events)
    }

    @Test func runsToolLoopAndReplaysHistoryUnchanged() async throws {
        let claude = ScriptedClaude([
            SSE.message([SSE.thinking("sig1"), SSE.toolUse(id: "tu1", name: "search_mail", inputFragments: ["{\"query\":\"deposit\"}"])], stopReason: "tool_use"),
            SSE.message([SSE.text("Next week [M1].")], stopReason: "end_turn"),
            SSE.message([SSE.text("You're welcome.")], stopReason: "end_turn"),
        ])
        let assistant = session(claude)
        let context = AssistantContext(accountIDs: [accountID], viewing: nil)

        let first = try await collect(assistant.send("When is my deposit back?", context: context))
        #expect(first.text == "Next week [M1].")
        let citations = first.events.compactMap { event -> [String: CitationTarget]? in
            if case let .citations(targets) = event { return targets }
            return nil
        }.last
        #expect(citations?["M1"]?.messageID == "m1")

        _ = try await collect(assistant.send("Thanks", context: context))

        let requests = claude.requests
        #expect(requests.count == 3)
        #expect(requests[0]["model"] == "claude-sonnet-5-5")
        #expect(requests[0]["fallbacks"] == "default")
        let toolTurn = try #require(requests[1]["messages"]?.arrayValue)
        #expect(toolTurn.count == 3)
        #expect(toolTurn[1]["content"]?.arrayValue?.first == ["type": "thinking", "thinking": "", "signature": "sig1"])
        let toolResult = try #require(toolTurn[2]["content"]?.arrayValue?.first)
        #expect(toolResult["tool_use_id"] == "tu1")
        #expect(toolResult["content"]?.stringValue?.contains("[M1]") == true)
        #expect(toolResult["content"]?.stringValue?.contains("Subject: Your flat") == true)

        let laterTurn = try #require(requests[2]["messages"]?.arrayValue)
        #expect(Array(laterTurn.prefix(3)) == toolTurn)
        #expect(laterTurn.count == 5)
    }

    @Test func refusalRollsBackTheTurn() async throws {
        let claude = ScriptedClaude([
            SSE.message([], stopReason: "refusal"),
            SSE.message([SSE.text("Hi")], stopReason: "end_turn"),
        ])
        let assistant = session(claude)
        let context = AssistantContext(accountIDs: [accountID], viewing: nil)
        await #expect(throws: AssistantError.self) { try await collect(assistant.send("bad", context: context)) }
        _ = try await collect(assistant.send("hello", context: context))
        #expect(claude.requests[1]["messages"]?.arrayValue?.count == 1)
    }

    @Test func invalidToolInputIsReturnedAsError() async throws {
        let claude = ScriptedClaude([
            SSE.message([SSE.toolUse(id: "tu1", name: "search_mail", inputFragments: ["{\"query\": "])], stopReason: "tool_use"),
            SSE.message([SSE.text("Sorry.")], stopReason: "end_turn"),
        ])
        _ = try await collect(session(claude).send("x", context: AssistantContext(accountIDs: [accountID], viewing: nil)))
        let result = try #require(claude.requests[1]["messages"]?.arrayValue?.last?["content"]?.arrayValue?.first)
        #expect(result["is_error"] == true)
        #expect(result["content"]?.stringValue?.contains("INVALID_JSON") == true)
    }

    @Test func draftReplyQuotesOriginalAndAddressesSender() async throws {
        let claude = ScriptedClaude([
            SSE.message([SSE.toolUse(id: "tu1", name: "draft_email", inputFragments: ["{\"reply_to\":\"M1\",\"body\":\"Thanks!\"}"])], stopReason: "tool_use"),
            SSE.message([SSE.text("Drafted.")], stopReason: "end_turn"),
        ])
        let context = AssistantContext(accountIDs: [accountID], viewing: ThreadRef(accountID: accountID, threadID: "t1"))
        let result = try await collect(session(claude).send("Reply thanks", context: context))
        let draft = try #require(result.events.compactMap { event -> DraftProposal? in
            if case let .draft(proposal) = event { return proposal }
            return nil
        }.first).draft
        #expect(draft.to.map(\.email) == ["ll@example.com"])
        #expect(draft.subject == "Re: Your flat")
        #expect(draft.body.hasPrefix("Thanks!\n\nOn "))
        #expect(draft.threadID == "t1")
        let note = claude.requests[0]["messages"]?.arrayValue?.first?["content"]?.arrayValue?.first?["text"]?.stringValue
        #expect(note?.contains("[M1] “Your flat”") == true)
    }
}
