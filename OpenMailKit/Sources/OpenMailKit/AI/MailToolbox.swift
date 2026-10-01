import Foundation

/// The mail tools the assistant can call, shared by the API and Codex backends.
/// Every message a tool shows gets a stable citation key such as M3 for the life of the conversation.
actor MailToolbox {
    struct Definition {
        var name: String
        var description: String
        var inputSchema: JSONValue
    }

    struct Output: Sendable {
        var text: String
        var isError: Bool
    }

    private let store: MailStore
    private let search: MailSearch
    private(set) var citations = CitationRegistry()

    init(store: MailStore, search: MailSearch) {
        self.store = store
        self.search = search
    }

    func call(
        _ name: String,
        input: JSONValue,
        context: AssistantContext,
        emit: @Sendable (AssistantEvent) -> Void
    ) async -> Output {
        defer { emit(.citations(citations.targets)) }
        do {
            return Output(text: try await execute(name, input: input, context: context, emit: emit), isError: false)
        } catch let error as ToolError {
            return Output(text: error.message, isError: true)
        } catch {
            return Output(text: error.localizedDescription, isError: true)
        }
    }

    func contextNote(_ context: AssistantContext) async throws -> String {
        var lines = [
            "Today is \(Date.now.formatted(date: .complete, time: .shortened)) (\(TimeZone.current.identifier)).",
            "Connected accounts: \(context.accountIDs.joined(separator: ", ")).",
        ]
        if let viewing = context.viewing, let latest = try await store.messages(in: viewing).last {
            let key = citations.key(for: latest)
            lines.append("The user has this conversation open: [\(key)] “\(latest.subject)” from \(latest.from?.formatted ?? "unknown"), \(latest.date.formatted(date: .abbreviated, time: .shortened)).")
        }
        return "<context>\n" + lines.joined(separator: "\n") + "\n</context>"
    }

    private func execute(
        _ name: String,
        input: JSONValue,
        context: AssistantContext,
        emit: @Sendable (AssistantEvent) -> Void
    ) async throws -> String {
        switch name.lowercased() {
        case "search_mail":
            let query = try input.requiredString("query")
            emit(.activity("Searching mail for “\(query)”"))
            let filters = SearchFilters(
                from: input["from"]?.stringValue,
                after: try input.optionalDay("after"),
                before: try input.optionalDay("before")
            )
            let hits = try await search.search(query, filters: filters, limit: input.clampedInt("limit", default: 10, range: 1...20))
            guard !hits.isEmpty else { return "No messages matched. Try other words, a sender's name, or a wider date range." }
            return "Found \(hits.count) messages, best match first:\n\n" + hits.map { hit in
                "\(describe(hit.message))\nExcerpt: \(hit.excerpt)"
            }.joined(separator: "\n\n")

        case "get_thread":
            let target = try target(for: input.requiredString("message_key"))
            let messages = try await store.messages(in: target.threadRef)
            guard let first = messages.first else { throw ToolError(message: "That conversation no longer exists.") }
            emit(.activity("Reading “\(first.subject)”"))
            return ThreadRenderer.render(messages, keys: messages.map { citations.key(for: $0) })

        case "list_threads":
            let mailbox = input["mailbox"]?.stringValue ?? "inbox"
            let labelID: String? = switch mailbox {
            case "inbox": SystemLabel.inbox
            case "sent": SystemLabel.sent
            case "starred": SystemLabel.starred
            case "all": nil
            default: throw ToolError(message: "mailbox must be one of inbox, sent, starred, all.")
            }
            emit(.activity("Looking through \(mailbox == "all" ? "all mail" : mailbox)"))
            let threads = try await store.recentThreads(
                accountIDs: nil,
                labelID: labelID,
                unreadOnly: input["unread_only"] == .bool(true),
                after: try input.optionalDay("after"),
                before: try input.optionalDay("before"),
                limit: input.clampedInt("limit", default: 20, range: 1...50)
            )
            guard !threads.isEmpty else { return "No conversations matched." }
            var lines: [String] = []
            for thread in threads {
                guard let latest = try await store.messages(in: thread.ref).last else { continue }
                let flags = [thread.isUnread ? "unread" : nil, thread.messageCount > 1 ? "\(thread.messageCount) messages" : nil]
                    .compactMap { $0 }.joined(separator: ", ")
                lines.append("\(describe(latest))\(flags.isEmpty ? "" : " · \(flags)")\nPreview: \(latest.snippet)")
            }
            return lines.joined(separator: "\n\n")

        case "draft_email":
            let body = try input.requiredString("body")
            var draft: OutgoingMessage
            if let replyKey = input["reply_to"]?.stringValue {
                let target = try target(for: replyKey)
                guard let original = try await store.message(accountID: target.accountID, messageID: target.messageID) else {
                    throw ToolError(message: "That message no longer exists.")
                }
                draft = .reply(to: original, accountID: target.accountID, replyAll: input["reply_all"] == .bool(true))
                draft.body = body + draft.body
            } else {
                guard let accountID = context.viewing?.accountID ?? context.accountIDs.first else {
                    throw ToolError(message: "No account is connected.")
                }
                draft = OutgoingMessage(accountID: accountID, subject: input["subject"]?.stringValue ?? "", body: body)
            }
            if let to = input["to"]?.arrayValue {
                draft.to = to.compactMap(\.stringValue).flatMap(OutgoingMessage.parseAddresses)
            }
            if let subject = input["subject"]?.stringValue, !subject.isEmpty { draft.subject = subject }
            emit(.draft(DraftProposal(draft: draft)))
            return "The draft is shown to the user to review, edit and send. It has not been sent."

        default:
            throw ToolError(message: "Unknown tool \(name). Available tools: search_mail, get_thread, list_threads, draft_email.")
        }
    }

    private func target(for key: String) throws -> CitationTarget {
        let normalized = key.trimmingCharacters(in: CharacterSet(charactersIn: "[] ")).uppercased()
        guard let target = citations.targets[normalized] else {
            throw ToolError(message: "Unknown message key \(key). Use a key such as M3 from an earlier tool result.")
        }
        return target
    }

    private func describe(_ message: Message) -> String {
        var parts = [
            "[\(citations.key(for: message))] \(message.date.formatted(.iso8601.year().month().day()))",
            "From: \(message.from?.formatted ?? "unknown")",
        ]
        if !message.to.isEmpty { parts.append("To: \(message.to.map(\.formatted).joined(separator: ", "))") }
        parts.append("Subject: \(message.subject.isEmpty ? "(no subject)" : message.subject)")
        parts.append("Account: \(message.accountID)")
        return parts.joined(separator: " · ")
    }
}


struct ToolError: Error {
    var message: String
}

struct CitationRegistry {
    private(set) var targets: [String: CitationTarget] = [:]
    private var keys: [MessageKey: String] = [:]

    mutating func key(for message: Message) -> String {
        let messageKey = MessageKey(accountID: message.accountID, messageID: message.id)
        if let existing = keys[messageKey] { return existing }
        let key = "M\(keys.count + 1)"
        keys[messageKey] = key
        targets[key] = CitationTarget(accountID: message.accountID, messageID: message.id, threadID: message.threadID)
        return key
    }
}

enum ThreadRenderer {
    static let maxBodyLength = 8_000
    static let maxTotalLength = 60_000

    static func render(_ messages: [Message], keys: [String]) -> String {
        var output = "Conversation “\(messages.first?.subject ?? "")” with \(messages.count) messages, oldest first.\n"
        for (message, key) in zip(messages, keys) {
            var body = Chunker.normalizedBody(message.bodyText)
            if body.isEmpty { body = message.snippet }
            if body.count > maxBodyLength {
                body = String(body.prefix(maxBodyLength)) + "\n[Message truncated: \(body.count - maxBodyLength) more characters not shown]"
            }
            let section = "\n---\n[\(key)]\n\(Chunker.header(for: message))\n\n\(body)\n"
            if output.count + section.count > maxTotalLength {
                output += "\n[Conversation truncated: the remaining \(messages.count - (keys.firstIndex(of: key) ?? 0)) messages are not shown]"
                break
            }
            output += section
        }
        return output
    }
}

extension JSONValue {
    func requiredString(_ key: String) throws -> String {
        guard let value = self[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            throw ToolError(message: "\(key) is required and must be a non-empty string.")
        }
        return value
    }

    func clampedInt(_ key: String, default defaultValue: Int, range: ClosedRange<Int>) -> Int {
        guard let value = self[key]?.intValue else { return defaultValue }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    /// Parses a `YYYY-MM-DD` field as the start of that day in the user's time zone.
    func optionalDay(_ key: String) throws -> Date? {
        guard let text = self[key]?.stringValue, !text.isEmpty else { return nil }
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else {
            throw ToolError(message: "\(key) must be a date in YYYY-MM-DD format.")
        }
        return date
    }
}
