import Foundation
@testable import OpenMailKit
import os

final class FakeGmail: GmailAPI {
    struct State {
        var messages: [String: GmailMessage] = [:]
        var order: [String] = []
        var history: [GmailHistoryRecord] = []
        var historyID = 100
        var expiredBefore = 0
        var pageSize = 2
        var labels = [GmailLabel(id: "INBOX", name: "INBOX", type: "system")]
        var modifications: [(String, [String], [String])] = []
        var sent: [(Data, String?)] = []
    }

    let state = OSAllocatedUnfairLock(uncheckedState: State())

    func add(_ message: GmailMessage, recordHistory: Bool = true) {
        state.withLockUnchecked { state in
            state.historyID += 1
            var message = message
            message.historyId = String(state.historyID)
            state.messages[message.id] = message
            state.order.insert(message.id, at: 0)
            if recordHistory {
                state.history.append(Self.record(state.historyID, added: [message]))
            }
        }
    }

    func setLabels(_ id: String, _ labels: [String]) {
        state.withLockUnchecked { state in
            state.historyID += 1
            state.messages[id]?.labelIds = labels
            state.messages[id]?.historyId = String(state.historyID)
            let ref = GmailMessageRef(id: id, threadId: state.messages[id]!.threadId)
            state.history.append(GmailHistoryRecord(id: String(state.historyID), labelsAdded: [.init(message: ref)]))
        }
    }

    func delete(_ id: String) {
        state.withLockUnchecked { state in
            state.historyID += 1
            let ref = GmailMessageRef(id: id, threadId: state.messages[id]!.threadId)
            state.messages[id] = nil
            state.order.removeAll { $0 == id }
            state.history.append(GmailHistoryRecord(id: String(state.historyID), messagesDeleted: [.init(message: ref)]))
        }
    }

    private static func record(_ id: Int, added: [GmailMessage]) -> GmailHistoryRecord {
        GmailHistoryRecord(
            id: String(id),
            messagesAdded: added.map { .init(message: GmailMessageRef(id: $0.id, threadId: $0.threadId)) }
        )
    }

    func profile() async throws -> GmailProfile {
        state.withLockUnchecked { GmailProfile(emailAddress: "me@example.com", messagesTotal: $0.messages.count, historyId: String($0.historyID)) }
    }

    func listMessages(pageToken: String?) async throws -> GmailMessageList {
        state.withLockUnchecked { state in
            let start = pageToken.flatMap(Int.init) ?? 0
            let end = min(start + state.pageSize, state.order.count)
            let refs = state.order[start..<end].map { GmailMessageRef(id: $0, threadId: state.messages[$0]!.threadId) }
            return GmailMessageList(messages: refs, nextPageToken: end < state.order.count ? String(end) : nil)
        }
    }

    func message(id: String, format: GmailMessageFormat) async throws -> GmailMessage {
        guard var message = state.withLockUnchecked({ $0.messages[id] }) else { throw GmailError.notFound }
        if format == .minimal { message.payload = nil }
        return message
    }

    func history(startHistoryID: String, pageToken: String?) async throws -> GmailHistoryPage {
        try state.withLockUnchecked { state in
            let start = Int(startHistoryID) ?? 0
            if start < state.expiredBefore { throw GmailError.historyExpired }
            let records = state.history.filter { Int($0.id)! > start }
            return GmailHistoryPage(history: records, nextPageToken: nil, historyId: String(state.historyID))
        }
    }

    func labels() async throws -> [GmailLabel] {
        state.withLockUnchecked { $0.labels }
    }

    func modifyThread(id: String, add: [String], remove: [String]) async throws {
        state.withLockUnchecked { $0.modifications.append((id, add, remove)) }
    }

    func trashThread(id: String) async throws {
        state.withLockUnchecked { $0.modifications.append((id, ["TRASH"], ["INBOX"])) }
    }

    func send(raw: Data, threadID: String?) async throws -> GmailMessageRef {
        state.withLockUnchecked { $0.sent.append((raw, threadID)) }
        return GmailMessageRef(id: "sent", threadId: threadID ?? "new")
    }

    func attachment(messageID: String, attachmentID: String) async throws -> Data {
        Data("attachment".utf8)
    }
}

enum Fixtures {
    static func message(
        id: String,
        thread: String,
        from: String = "Alice <alice@example.com>",
        subject: String = "Hello",
        body: String = "Hi there",
        labels: [String] = ["INBOX", "UNREAD"],
        date: Int = 1_700_000_000_000
    ) -> GmailMessage {
        GmailMessage(
            id: id,
            threadId: thread,
            labelIds: labels,
            snippet: body,
            historyId: "1",
            internalDate: String(date),
            payload: GmailPart(
                partId: "",
                mimeType: "text/plain",
                filename: "",
                headers: [
                    GmailHeader(name: "From", value: from),
                    GmailHeader(name: "To", value: "me@example.com"),
                    GmailHeader(name: "Subject", value: subject),
                    GmailHeader(name: "Message-ID", value: "<\(id)@example.com>"),
                    GmailHeader(name: "Content-Type", value: "text/plain; charset=utf-8"),
                ],
                body: GmailBody(size: body.utf8.count, data: Data(body.utf8).base64URLEncodedString())
            )
        )
    }
}
