import Foundation
import os

public struct CodexStatus: Sendable, Equatable {
    public var executable: URL?
    public var isLoggedIn: Bool
    /// How Codex is signed in, as Codex reports it, for example "Logged in using ChatGPT".
    public var detail: String?
    public var problem: String?
}

/// A launched command: its stdout as lines, a way to read stderr afterwards, and a way to stop it.
struct RunningCommand: Sendable {
    var lines: AsyncThrowingStream<String, any Error>
    var standardError: @Sendable () -> String
    var interrupt: @Sendable () -> Void
}

protocol CommandRunner: Sendable {
    func run(_ executable: URL, arguments: [String], environment: [String: String], directory: URL) throws -> RunningCommand
}

struct ProcessRunner: CommandRunner {
    func run(_ executable: URL, arguments: [String], environment: [String: String], directory: URL) throws -> RunningCommand {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = directory
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice

        let errorText = OSAllocatedUnfairLock(initialState: Data())
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            errorText.withLock { $0.append(chunk) }
        }
        try process.run()

        let lines = AsyncThrowingStream<String, any Error> { continuation in
            let task = Task {
                do {
                    for try await line in stdout.fileHandleForReading.bytes.lines { continuation.yield(line) }
                    process.waitUntilExit()
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
                if process.isRunning { process.interrupt() }
            }
        }
        return RunningCommand(
            lines: lines,
            standardError: { String(decoding: errorText.withLock { $0 }, as: UTF8.self) },
            interrupt: { if process.isRunning { process.interrupt() } }
        )
    }
}

/// Finds the user's installed `codex` command and runs it with a clean environment.
struct CodexCLI: Sendable {
    let executable: URL
    let runner: any CommandRunner

    static func locate(runner: any CommandRunner = ProcessRunner()) async -> CodexCLI? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.local/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ]
        if let path = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) {
            return CodexCLI(executable: URL(filePath: path), runner: runner)
        }
        // GUI apps don't inherit the shell's PATH (npm and nvm installs live there), so ask a login shell.
        guard let command = try? runner.run(
            URL(filePath: "/bin/zsh"),
            arguments: ["-lc", "command -v codex"],
            environment: ProcessInfo.processInfo.environment,
            directory: URL(filePath: home)
        ) else { return nil }
        var output = ""
        do {
            for try await line in command.lines { output += line }
        } catch {
            return nil
        }
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard path.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: path) else { return nil }
        return CodexCLI(executable: URL(filePath: path), runner: runner)
    }

    /// The parent environment minus API keys, so usage goes to the user's ChatGPT sign-in rather than a key.
    static func childEnvironment(_ base: [String: String] = ProcessInfo.processInfo.environment, extra: [String: String] = [:]) -> [String: String] {
        var environment = base.filter { key, _ in key != "OPENAI_API_KEY" && key != "CODEX_API_KEY" }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extraPaths = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let existing = environment["PATH"].map { $0.split(separator: ":").map(String.init) } ?? []
        environment["PATH"] = (existing + extraPaths.filter { !existing.contains($0) }).joined(separator: ":")
        environment.merge(extra) { _, new in new }
        return environment
    }

    func run(_ arguments: [String], directory: URL, environment extra: [String: String] = [:]) throws -> RunningCommand {
        try runner.run(executable, arguments: arguments, environment: Self.childEnvironment(extra: extra), directory: directory)
    }

    func status() async -> CodexStatus {
        var status = CodexStatus(executable: executable, isLoggedIn: false)
        do {
            let command = try run(["login", "status"], directory: FileManager.default.temporaryDirectory)
            var output = ""
            for try await line in command.lines { output += line + "\n" }
            let text = (output + command.standardError()).trimmingCharacters(in: .whitespacesAndNewlines)
            let firstLine = text.split(separator: "\n").first.map(String.init) ?? text
            status.isLoggedIn = firstLine.lowercased().hasPrefix("logged in")
            status.detail = firstLine
            if !status.isLoggedIn { status.problem = "Codex isn't signed in. Run `codex login` in Terminal." }
        } catch {
            status.problem = "Couldn't check Codex's sign-in: \(error.localizedDescription)"
        }
        return status
    }
}
