import Foundation
@testable import OpenMailKit
import os
import Testing

/// Pretends to be `codex exec --json`: calls OpenMail's MCP server the way Codex would, then emits Codex events.
final class FakeCodexRunner: CommandRunner {
    struct Call {
        var arguments: [String]
        var environment: [String: String]
        var directory: URL
    }

    private let calls = OSAllocatedUnfairLock<[Call]>(uncheckedState: [])
    let toolCall: JSONValue?
    let answers: [String]
    let failure: String?

    init(toolCall: JSONValue? = nil, answers: [String] = ["Done."], failure: String? = nil) {
        self.toolCall = toolCall
        self.answers = answers
        self.failure = failure
    }

    var recorded: [Call] { calls.withLockUnchecked { $0 } }

    func run(_ executable: URL, arguments: [String], environment: [String: String], directory: URL) throws -> RunningCommand {
        calls.withLockUnchecked { $0.append(Call(arguments: arguments, environment: environment, directory: directory)) }
        let url = Self.override("mcp_servers.openmail.url", in: arguments)!
        let token = environment[Self.override("mcp_servers.openmail.bearer_token_env_var", in: arguments)!]!
        let (toolCall, answers, failure) = (toolCall, answers, failure)
        let lines = AsyncThrowingStream<String, any Error> { continuation in
            Task {
                do {
                    func post(_ body: JSONValue) async throws -> JSONValue? {
                        var request = URLRequest(url: URL(string: url)!)
                        request.httpMethod = "POST"
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                        request.httpBody = try body.encoded()
                        let (data, _) = try await URLSession.shared.data(for: request)
                        return data.isEmpty ? nil : try JSONValue.parse(data)
                    }
                    _ = try await post(["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["protocolVersion": "2025-06-18"]])
                    continuation.yield(#"{"type":"thread.started","thread_id":"thread-1"}"#)
                    continuation.yield(#"{"type":"turn.started"}"#)
                    if let failure {
                        continuation.yield(String(decoding: try JSONValue.object(["type": "turn.failed", "error": ["message": .string(failure)]]).encoded(), as: UTF8.self))
                        continuation.finish()
                        return
                    }
                    if let toolCall {
                        let reply = try await post(["jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": toolCall])
                        let text = reply?["result"]?["content"]?.arrayValue?.first?["text"]?.stringValue ?? ""
                        continuation.yield(try Self.message("[tool:\(text.contains("[M1]"))]"))
                    }
                    for answer in answers { continuation.yield(try Self.message(answer)) }
                    continuation.yield(#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
        return RunningCommand(lines: lines, standardError: { "" }, interrupt: {})
    }

    static func override(_ key: String, in arguments: [String]) -> String? {
        let prefix = "\(key)="
        guard let value = arguments.first(where: { $0.hasPrefix(prefix) })?.dropFirst(prefix.count) else { return nil }
        return String(value).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }

    private static func message(_ text: String) throws -> String {
        let event: JSONValue = ["type": "item.completed", "item": ["id": "item", "type": "agent_message", "text": .string(text)]]
        return String(decoding: try event.encoded(), as: UTF8.self)
    }
}

struct CodexTests {
    let gmail = FakeGmail()
    let store: MailStore
    let accountID = "me@example.com"
    let directory = FileManager.default.temporaryDirectory.appending(path: "openmail-codex-\(UUID().uuidString)")

    init() async throws {
        store = try MailStore.inMemory()
        gmail.add(Fixtures.message(id: "m1", thread: "t1", from: "Landlord <ll@example.com>", subject: "Your flat", body: "The deposit will be returned next week."), recordHistory: false)
        try await store.saveAccount(Account(id: accountID, historyID: "1", messagesTotal: 1))
        try await AccountSync(accountID: accountID, gmail: gmail, store: store).backfill()
    }

    private var toolbox: MailToolbox {
        MailToolbox(store: store, search: MailSearch(store: store, vectors: VectorIndex(store: store), embeddings: nil))
    }

    private func session(_ runner: FakeCodexRunner) -> CodexSession {
        CodexSession(cli: CodexCLI(executable: URL(filePath: "/usr/bin/true"), runner: runner), toolbox: toolbox, directory: directory)
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

    @Test func mcpHandlerListsAndRunsTools() async throws {
        let emitted = OSAllocatedUnfairLock<[String]>(uncheckedState: [])
        let handler = MCPToolHandler(toolbox: toolbox, activeTurn: {
            ActiveTurn(context: AssistantContext(accountIDs: [accountID], viewing: nil), emit: { event in
                if case let .activity(text) = event { emitted.withLockUnchecked { $0.append(text) } }
            })
        })
        let initialize = await handler.handle(["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["protocolVersion": "2025-06-18"]])
        #expect(initialize?["result"]?["protocolVersion"] == "2025-06-18")
        #expect(await handler.handle(["jsonrpc": "2.0", "method": "notifications/initialized"]) == nil)

        let list = await handler.handle(["jsonrpc": "2.0", "id": 2, "method": "tools/list"])
        let names = list?["result"]?["tools"]?.arrayValue?.compactMap { $0["name"]?.stringValue }
        #expect(names == ["search_mail", "get_thread", "list_threads", "draft_email"])

        let call = await handler.handle(["jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": ["name": "search_mail", "arguments": ["query": "deposit"]]])
        #expect(call?["result"]?["isError"] == false)
        #expect(call?["result"]?["content"]?.arrayValue?.first?["text"]?.stringValue?.contains("[M1]") == true)
        #expect(emitted.withLockUnchecked { $0 } == ["Searching mail for “deposit”"])

        let unknown = await handler.handle(["jsonrpc": "2.0", "id": 4, "method": "resources/list"])
        #expect(unknown?["error"]?["code"] == -32601)
    }

    @Test func mcpServerRequiresToken() async throws {
        let server = try await MCPServer.start { message in ["jsonrpc": "2.0", "id": message["id"] ?? .null, "result": [:]] }
        defer { server.stop() }
        var request = URLRequest(url: server.url)
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.utf8)
        let (_, unauthorized) = try await URLSession.shared.data(for: request)
        #expect((unauthorized as? HTTPURLResponse)?.statusCode == 401)

        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        let (data, authorized) = try await URLSession.shared.data(for: request)
        #expect((authorized as? HTTPURLResponse)?.statusCode == 200)
        #expect(try JSONValue.parse(data)["id"] == 1)
    }

    @Test func sessionRunsLockedDownCodexAndResumesThread() async throws {
        let runner = FakeCodexRunner(toolCall: ["name": "search_mail", "arguments": ["query": "deposit"]], answers: ["Next week [M1]."])
        let assistant = session(runner)
        let context = AssistantContext(accountIDs: [accountID], viewing: nil)

        let first = try await collect(assistant.send("When is my deposit back?", context: context))
        #expect(first.text == "[tool:true]\n\nNext week [M1].")
        #expect(first.events.contains { if case .activity = $0 { true } else { false } })
        _ = try await collect(assistant.send("Thanks", context: context))
        await assistant.close()

        let calls = runner.recorded
        #expect(calls.count == 2)
        let arguments = calls[0].arguments
        #expect(arguments.prefix(2) == ["exec", "--json"])
        #expect(arguments.last?.hasPrefix("<context>") == true)
        #expect(arguments.last?.hasSuffix("When is my deposit back?") == true)
        #expect(arguments.contains("--ignore-user-config"))
        for feature in ["shell_tool", "unified_exec", "apps", "browser_use", "computer_use"] {
            #expect(arguments.indices.contains { arguments[$0] == "--disable" && arguments[$0 + 1] == feature })
        }
        #expect(FakeCodexRunner.override("sandbox_mode", in: arguments) == "read-only")
        #expect(FakeCodexRunner.override("approval_policy", in: arguments) == "never")
        #expect(FakeCodexRunner.override("web_search", in: arguments) == "disabled")
        let instructions = try String(contentsOf: URL(filePath: FakeCodexRunner.override("model_instructions_file", in: arguments)!), encoding: .utf8)
        #expect(instructions == AssistantPrompt.system)
        #expect(!arguments.joined(separator: " ").contains(calls[0].environment[CodexSession.tokenVariable]!))
        #expect(calls[1].arguments.prefix(3) == ["exec", "resume", "thread-1"])
        #expect(calls[0].directory == directory)
    }

    @Test func surfacesSignInFailures() async throws {
        let runner = FakeCodexRunner(failure: "401 Unauthorized: please log in")
        await #expect(throws: CodexError.self) {
            try await collect(session(runner).send("hi", context: AssistantContext(accountIDs: [accountID], viewing: nil)))
        }
    }

    @Test func childEnvironmentDropsAPIKeys() {
        let environment = CodexCLI.childEnvironment(
            ["HOME": "/Users/me", "PATH": "/usr/bin", "OPENAI_API_KEY": "sk-test", "CODEX_API_KEY": "ck"],
            extra: ["OPENMAIL_MCP_TOKEN": "t"]
        )
        #expect(environment["OPENAI_API_KEY"] == nil)
        #expect(environment["CODEX_API_KEY"] == nil)
        #expect(environment["OPENMAIL_MCP_TOKEN"] == "t")
        #expect(environment["PATH"]?.hasPrefix("/usr/bin:") == true)
    }

    @Test func tomlStringsAreEscaped() {
        #expect(CodexSession.tomlString("a \"b\"\nc\\d") == #""a \"b\"\nc\\d""#)
    }
}

/// Opt-in: runs the real `codex` CLI. Set OPENMAIL_LIVE_CODEX=1. Uses a small amount of the signed-in ChatGPT plan.
struct CodexLiveTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENMAIL_LIVE_CODEX"] == "1"))
    func realCodexAnswersWithMailTools() async throws {
        let gmail = FakeGmail()
        let store = try MailStore.inMemory()
        gmail.add(Fixtures.message(id: "m1", thread: "t1", from: "Landlord <ll@example.com>", subject: "Your flat", body: "Your deposit will be returned on Friday 9 October."), recordHistory: false)
        try await store.saveAccount(Account(id: "me@example.com", historyID: "1", messagesTotal: 1))
        try await AccountSync(accountID: "me@example.com", gmail: gmail, store: store).backfill()
        let toolbox = MailToolbox(store: store, search: MailSearch(store: store, vectors: VectorIndex(store: store), embeddings: nil))
        let cli = try #require(await CodexCLI.locate())
        let session = CodexSession(cli: cli, toolbox: toolbox, directory: FileManager.default.temporaryDirectory.appending(path: "openmail-live-\(UUID().uuidString)"))
        var text = ""
        var activities: [String] = []
        for try await event in session.send("When is my deposit coming back?", context: AssistantContext(accountIDs: ["me@example.com"], viewing: nil)) {
            switch event {
            case let .text(delta): text += delta
            case let .activity(description): activities.append(description)
            default: break
            }
        }
        await session.close()
        print("Codex answered: \(text)\nActivities: \(activities)")
        #expect(text.contains("[M1]"))
        #expect(!activities.isEmpty)
    }
}
