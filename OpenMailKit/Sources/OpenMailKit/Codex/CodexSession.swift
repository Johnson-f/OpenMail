import Foundation
import os

public enum CodexError: Error, LocalizedError {
    case notInstalled
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .notInstalled: "Codex isn't installed. Install it with `npm install -g @openai/codex` or `brew install codex`, or switch the assistant to an API key in Settings."
        case let .failed(message): message
        }
    }
}

/// One assistant conversation run through the user's own Codex install, billed to their ChatGPT plan.
/// OpenMail serves its mail tools to Codex over a private MCP server; Codex's shell, browser and other tools are disabled.
public actor CodexSession: AssistantBackend {
    static let tokenVariable = "OPENMAIL_MCP_TOKEN"

    /// Codex features that would let the agent act outside OpenMail's mail tools.
    static let disabledFeatures = [
        "shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
        "browser_use_full_cdp_access", "computer_use", "in_app_browser", "in_app_local_automation", "image_generation",
        "view_image", "memories", "multi_agent", "hooks", "goals", "skill_search", "tool_suggest",
        "workspace_dependencies", "skill_mcp_dependency_install", "sleep_tool",
    ]

    private let cli: CodexCLI
    private let toolbox: MailToolbox
    private let directory: URL
    private let turn = OSAllocatedUnfairLock<ActiveTurn?>(uncheckedState: nil)
    private var server: MCPServer?
    private var threadID: String?

    init(cli: CodexCLI, toolbox: MailToolbox, directory: URL) {
        self.cli = cli
        self.toolbox = toolbox
        self.directory = directory
    }

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

    public func close() {
        server?.stop()
        server = nil
    }

    private func run(_ text: String, context: AssistantContext, events: AsyncThrowingStream<AssistantEvent, any Error>.Continuation) async throws {
        let server = try await prepare()
        turn.withLockUnchecked { $0 = ActiveTurn(context: context, emit: { events.yield($0) }) }
        defer { turn.withLockUnchecked { $0 = nil } }

        let prompt = try await toolbox.contextNote(context) + "\n\n" + text
        let command = try cli.run(
            arguments(prompt: prompt, serverURL: server.url),
            directory: directory,
            environment: [Self.tokenVariable: server.token]
        )
        var parser = CodexEventParser()
        do {
            for try await line in command.lines {
                for event in parser.consume(line) { events.yield(event) }
            }
        } catch is CancellationError {
            command.interrupt()
            throw CancellationError()
        }
        try Task.checkCancellation()
        threadID = parser.threadID ?? threadID
        if let failure = parser.failure { throw CodexError.failed(failure) }
        guard parser.completed else {
            let detail = command.standardError().trimmingCharacters(in: .whitespacesAndNewlines)
            throw CodexError.failed(detail.isEmpty ? "Codex stopped without answering." : CodexEventParser.describeFailure(detail))
        }
    }

    func arguments(prompt: String, serverURL: URL) -> [String] {
        var arguments = ["exec"]
        if let threadID { arguments += ["resume", threadID] }
        arguments += ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]
        for feature in Self.disabledFeatures { arguments += ["--disable", feature] }
        let overrides: [(String, String)] = [
            ("sandbox_mode", "read-only"),
            ("approval_policy", "never"),
            ("web_search", "disabled"),
            ("model_reasoning_effort", "medium"),
            ("model_instructions_file", instructionsURL.path),
            ("mcp_servers.openmail.url", serverURL.absoluteString),
            ("mcp_servers.openmail.bearer_token_env_var", Self.tokenVariable),
            ("mcp_servers.openmail.default_tools_approval_mode", "approve"),
        ]
        for (key, value) in overrides { arguments += ["-c", "\(key)=\(Self.tomlString(value))"] }
        arguments += ["-c", "project_doc_max_bytes=0", "-c", "mcp_servers.openmail.required=true"]
        arguments.append(prompt)
        return arguments
    }

    private var instructionsURL: URL { directory.appending(path: "instructions.md") }

    /// Starts the MCP server once per conversation and writes Codex's replacement instructions.
    private func prepare() async throws -> MCPServer {
        if let server { return server }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(AssistantPrompt.system.utf8).write(to: instructionsURL)
        let handler = MCPToolHandler(toolbox: toolbox, activeTurn: { [turn] in turn.withLockUnchecked { $0 } })
        let server = try await MCPServer.start(handler: handler.handle)
        self.server = server
        return server
    }

    static func tomlString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }
}

/// Turns `codex exec --json` lines into assistant events.
struct CodexEventParser {
    private(set) var threadID: String?
    private(set) var completed = false
    private(set) var failure: String?
    private var hasText = false

    mutating func consume(_ line: String) -> [AssistantEvent] {
        guard let event = try? JSONValue.parse(Data(line.utf8)) else { return [] }
        switch event["type"]?.stringValue {
        case "thread.started":
            threadID = event["thread_id"]?.stringValue
        case "item.completed":
            guard event["item"]?["type"] == "agent_message", let text = event["item"]?["text"]?.stringValue, !text.isEmpty else { break }
            defer { hasText = true }
            return [.text(hasText ? "\n\n" + text : text)]
        case "turn.completed":
            completed = true
        case "turn.failed":
            failure = Self.describeFailure(event["error"]?["message"]?.stringValue ?? "The request failed.")
        case "error":
            failure = Self.describeFailure(event["message"]?.stringValue ?? "The request failed.")
        default:
            break
        }
        return []
    }

    static func describeFailure(_ message: String) -> String {
        let lowered = message.lowercased()
        if lowered.contains("login") || lowered.contains("log in") || lowered.contains("401") || lowered.contains("unauthorized") {
            return "Codex isn't signed in. Open Terminal and run `codex login`. (\(message))"
        }
        if lowered.contains("usage limit") || lowered.contains("rate limit") {
            return "Your ChatGPT plan's Codex usage limit was reached. (\(message))"
        }
        return "Codex: \(message)"
    }
}
