import Foundation
import GRDB

public final class MailStore: Sendable {
    let db: any DatabaseWriter

    public static func open(at url: URL) throws -> MailStore {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return try MailStore(writer: DatabasePool(path: url.path, configuration: configuration()))
    }

    public static func inMemory() throws -> MailStore {
        try MailStore(writer: DatabaseQueue(configuration: configuration()))
    }

    private static func configuration() -> Configuration {
        var config = Configuration()
        config.foreignKeysEnabled = true
        return config
    }

    private init(writer: any DatabaseWriter) throws {
        db = writer
        try Self.migrator.migrate(writer)
    }

    private static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.create(table: "accounts") { t in
                t.primaryKey("id", .text)
                t.column("historyID", .text)
                t.column("backfillPageToken", .text)
                t.column("backfillComplete", .boolean).notNull()
                t.column("messagesTotal", .integer).notNull()
                t.column("needsReauth", .boolean).notNull()
                t.column("lastError", .text)
                t.column("addedAt", .datetime).notNull()
                t.column("syncGeneration", .integer).notNull()
            }
            try db.create(table: "labels") { t in
                t.column("accountID", .text).notNull().references("accounts", onDelete: .cascade)
                t.column("id", .text).notNull()
                t.column("name", .text).notNull()
                t.column("isSystem", .boolean).notNull()
                t.primaryKey(["accountID", "id"])
            }
            try db.create(table: "messages") { t in
                t.column("accountID", .text).notNull().references("accounts", onDelete: .cascade)
                t.column("id", .text).notNull()
                t.column("threadID", .text).notNull()
                t.column("historyID", .text).notNull()
                t.column("date", .datetime).notNull()
                t.column("labelIDs", .jsonText).notNull()
                t.column("snippet", .text).notNull()
                t.column("subject", .text).notNull()
                t.column("from", .jsonText)
                t.column("to", .jsonText).notNull()
                t.column("cc", .jsonText).notNull()
                t.column("replyTo", .jsonText).notNull()
                t.column("messageIDHeader", .text)
                t.column("references", .text)
                t.column("bodyText", .text).notNull()
                t.column("bodyHTML", .text)
                t.column("syncGeneration", .integer).notNull()
                t.primaryKey(["accountID", "id"])
            }
            try db.create(index: "messages_thread", on: "messages", columns: ["accountID", "threadID"])
            try db.create(table: "attachments") { t in
                t.column("accountID", .text).notNull()
                t.column("messageID", .text).notNull()
                t.column("partID", .text).notNull()
                t.column("gmailAttachmentID", .text).notNull()
                t.column("filename", .text).notNull()
                t.column("mimeType", .text).notNull()
                t.column("size", .integer).notNull()
                t.primaryKey(["accountID", "messageID", "partID"])
                t.foreignKey(["accountID", "messageID"], references: "messages", onDelete: .cascade)
            }
            try db.create(table: "threads") { t in
                t.column("accountID", .text).notNull().references("accounts", onDelete: .cascade)
                t.column("id", .text).notNull()
                t.column("subject", .text).notNull()
                t.column("snippet", .text).notNull()
                t.column("participants", .text).notNull()
                t.column("lastMessageDate", .datetime).notNull()
                t.column("messageCount", .integer).notNull()
                t.column("isUnread", .boolean).notNull()
                t.column("isStarred", .boolean).notNull()
                t.column("hasAttachments", .boolean).notNull()
                t.column("isHidden", .boolean).notNull()
                t.primaryKey(["accountID", "id"])
            }
            try db.create(index: "threads_date", on: "threads", columns: ["lastMessageDate"])
            try db.create(table: "threadLabels") { t in
                t.column("accountID", .text).notNull()
                t.column("threadID", .text).notNull()
                t.column("labelID", .text).notNull()
                t.primaryKey(["accountID", "threadID", "labelID"])
                t.foreignKey(["accountID", "threadID"], references: "threads", onDelete: .cascade)
            }
            try db.create(index: "threadLabels_label", on: "threadLabels", columns: ["labelID", "accountID"])
        }
        registerSearchMigrations(&migrator)
        return migrator
    }
}

// MARK: - Accounts and labels

extension MailStore {
    public func account(_ id: String) async throws -> Account? {
        try await db.read { try Account.fetchOne($0, key: id) }
    }

    public func accounts() async throws -> [Account] {
        try await db.read { try Account.order(Column("addedAt")).fetchAll($0) }
    }

    func saveAccount(_ account: Account) async throws {
        try await db.write { try account.upsert($0) }
    }

    func updateAccount(_ id: String, _ change: @escaping @Sendable (inout Account) -> Void) async throws {
        try await db.write { db in
            guard var account = try Account.fetchOne(db, key: id) else { return }
            change(&account)
            try account.update(db)
        }
    }

    func deleteAccount(_ id: String) async throws {
        _ = try await db.write { try Account.deleteOne($0, key: id) }
    }

    func replaceLabels(_ labels: [MailLabel], accountID: String) async throws {
        try await db.write { db in
            try MailLabel.filter(Column("accountID") == accountID).deleteAll(db)
            for label in labels { try label.insert(db) }
        }
    }
}

// MARK: - Messages and threads

extension MailStore {
    func syncGenerations(of ids: [String], accountID: String) async throws -> [String: Int] {
        try await db.read { db in
            let rows = try Row.fetchAll(
                db,
                Message.select(Column("id"), Column("syncGeneration"))
                    .filter(Column("accountID") == accountID && ids.contains(Column("id")))
            )
            return Dictionary(uniqueKeysWithValues: rows.map { ($0["id"] as String, $0["syncGeneration"] as Int) })
        }
    }

    /// Saves messages, skipping any that are older than the stored copy, and rebuilds affected threads.
    func saveMessages(_ parsed: [ParsedMessage], generation: Int) async throws {
        guard !parsed.isEmpty else { return }
        try await db.write { db in
            var touched = Set<ThreadRef>()
            for item in parsed {
                var message = item.message
                message.syncGeneration = generation
                let existing = try Message.fetchOne(db, key: ["accountID": message.accountID, "id": message.id])
                if var existing, HistoryID(existing.historyID) > HistoryID(message.historyID) {
                    existing.syncGeneration = max(existing.syncGeneration, generation)
                    try existing.update(db)
                    continue
                }
                let isNew = existing == nil
                try message.upsert(db)
                if isNew {
                    let rowID = try Int64.fetchOne(
                        db,
                        sql: "SELECT rowid FROM messages WHERE accountID = ? AND id = ?",
                        arguments: [message.accountID, message.id]
                    )!
                    try Self.indexForSearch(message, rowID: rowID, db: db)
                }
                try Attachment
                    .filter(Column("accountID") == message.accountID && Column("messageID") == message.id)
                    .deleteAll(db)
                for attachment in item.attachments { try attachment.insert(db) }
                touched.insert(ThreadRef(accountID: message.accountID, threadID: message.threadID))
            }
            for ref in touched { try Self.rebuildThread(ref, db: db) }
        }
    }

    func updateLabels(messageID: String, accountID: String, labelIDs: [String], historyID: String, generation: Int) async throws {
        try await db.write { db in
            guard var message = try Message.fetchOne(db, key: ["accountID": accountID, "id": messageID]) else { return }
            message.syncGeneration = generation
            if HistoryID(message.historyID) <= HistoryID(historyID) {
                message.labelIDs = labelIDs
                message.historyID = historyID
            }
            try message.update(db)
            try Self.rebuildThread(ThreadRef(accountID: accountID, threadID: message.threadID), db: db)
        }
    }

    /// Applies a label change locally to every message in a thread, ahead of the next sync.
    func applyLabelChange(_ ref: ThreadRef, add: [String], remove: [String]) async throws {
        try await db.write { db in
            let messages = try Message
                .filter(Column("accountID") == ref.accountID && Column("threadID") == ref.threadID)
                .fetchAll(db)
            for var message in messages {
                var labels = message.labelIDs.filter { !remove.contains($0) }
                labels.append(contentsOf: add.filter { !labels.contains($0) })
                message.labelIDs = labels
                try message.update(db)
            }
            try Self.rebuildThread(ref, db: db)
        }
    }

    func deleteMessages(_ ids: [String], accountID: String) async throws {
        guard !ids.isEmpty else { return }
        try await db.write { db in
            let threadIDs = try String.fetchSet(
                db,
                Message.select(Column("threadID"))
                    .filter(Column("accountID") == accountID && ids.contains(Column("id")))
            )
            try Message.filter(Column("accountID") == accountID && ids.contains(Column("id"))).deleteAll(db)
            for threadID in threadIDs {
                try Self.rebuildThread(ThreadRef(accountID: accountID, threadID: threadID), db: db)
            }
        }
    }

    func deleteMessages(accountID: String, olderThanGeneration generation: Int) async throws {
        let ids = try await db.read { db in
            try String.fetchAll(
                db,
                Message.select(Column("id"))
                    .filter(Column("accountID") == accountID && Column("syncGeneration") < generation)
            )
        }
        try await deleteMessages(ids, accountID: accountID)
    }

    private static func rebuildThread(_ ref: ThreadRef, db: Database) throws {
        let messages = try Message
            .filter(Column("accountID") == ref.accountID && Column("threadID") == ref.threadID)
            .order(Column("date"))
            .fetchAll(db)
        guard let latest = messages.last else {
            try MailThread.deleteOne(db, key: ["accountID": ref.accountID, "id": ref.threadID])
            return
        }
        let visible = messages.filter { !$0.isHidden }
        let relevant = visible.isEmpty ? messages : visible
        let attachmentCount = try Attachment
            .filter(Column("accountID") == ref.accountID && messages.map(\.id).contains(Column("messageID")))
            .fetchCount(db)
        let thread = MailThread(
            accountID: ref.accountID,
            id: ref.threadID,
            subject: messages.first(where: { !$0.subject.isEmpty })?.subject ?? "",
            snippet: latest.snippet,
            participants: participants(of: relevant, accountEmail: ref.accountID),
            lastMessageDate: latest.date,
            messageCount: messages.count,
            isUnread: relevant.contains(where: \.isUnread),
            isStarred: relevant.contains { $0.labelIDs.contains(SystemLabel.starred) },
            hasAttachments: attachmentCount > 0,
            isHidden: visible.isEmpty
        )
        try thread.upsert(db)
        try ThreadLabel.filter(Column("accountID") == ref.accountID && Column("threadID") == ref.threadID).deleteAll(db)
        for labelID in Set(relevant.flatMap(\.labelIDs)) {
            try ThreadLabel(accountID: ref.accountID, threadID: ref.threadID, labelID: labelID).insert(db)
        }
    }

    private static func participants(of messages: [Message], accountEmail: String) -> String {
        var seen = Set<String>()
        var names: [String] = []
        for message in messages {
            guard let from = message.from, seen.insert(from.email.lowercased()).inserted else { continue }
            names.append(from.email.caseInsensitiveCompare(accountEmail) == .orderedSame ? "me" : from.displayName)
        }
        return names.suffix(3).joined(separator: ", ")
    }
}

// MARK: - Reading

extension MailStore {
    public func observeAccounts() -> AsyncValueObservation<[Account]> {
        ValueObservation
            .tracking { try Account.order(Column("addedAt")).fetchAll($0) }
            .values(in: db)
    }

    public func observeLabels() -> AsyncValueObservation<[MailLabel]> {
        ValueObservation
            .tracking { try MailLabel.order(Column("name").collating(.localizedCaseInsensitiveCompare)).fetchAll($0) }
            .values(in: db)
    }

    public func observeMessageCounts() -> AsyncValueObservation<[String: Int]> {
        ValueObservation
            .tracking { db in
                let rows = try Row.fetchAll(db, sql: "SELECT accountID, COUNT(*) AS n FROM messages GROUP BY accountID")
                return Dictionary(uniqueKeysWithValues: rows.map { ($0["accountID"] as String, $0["n"] as Int) })
            }
            .values(in: db)
    }

    public func observeThreads(in mailbox: Mailbox, limit: Int) -> AsyncValueObservation<[MailThread]> {
        ValueObservation
            .tracking { try Self.threads(in: mailbox, limit: limit, db: $0) }
            .removeDuplicates()
            .values(in: db)
    }

    public func observeThread(_ ref: ThreadRef) -> AsyncValueObservation<MailThread?> {
        ValueObservation
            .tracking { try MailThread.fetchOne($0, key: ["accountID": ref.accountID, "id": ref.threadID]) }
            .removeDuplicates()
            .values(in: db)
    }

    public func observeMessages(in ref: ThreadRef) -> AsyncValueObservation<[MessageWithAttachments]> {
        ValueObservation
            .tracking { db in
                let messages = try Message
                    .filter(Column("accountID") == ref.accountID && Column("threadID") == ref.threadID)
                    .order(Column("date"))
                    .fetchAll(db)
                let attachments = try Attachment
                    .filter(Column("accountID") == ref.accountID && messages.map(\.id).contains(Column("messageID")))
                    .fetchAll(db)
                let byMessage = Dictionary(grouping: attachments, by: \.messageID)
                return messages.map { MessageWithAttachments(message: $0, attachments: byMessage[$0.id] ?? []) }
            }
            .removeDuplicates()
            .values(in: db)
    }

    public func threads(in mailbox: Mailbox, limit: Int) async throws -> [MailThread] {
        try await db.read { try Self.threads(in: mailbox, limit: limit, db: $0) }
    }

    func messages(in ref: ThreadRef) async throws -> [Message] {
        try await db.read { db in
            try Message
                .filter(Column("accountID") == ref.accountID && Column("threadID") == ref.threadID)
                .order(Column("date"))
                .fetchAll(db)
        }
    }

    private static func threads(in mailbox: Mailbox, limit: Int, db: Database) throws -> [MailThread] {
        switch mailbox {
        case .allInboxes:
            return try MailThread.fetchAll(db, sql: """
                SELECT threads.* FROM threads
                JOIN threadLabels ON threadLabels.accountID = threads.accountID AND threadLabels.threadID = threads.id
                WHERE threadLabels.labelID = ? AND NOT threads.isHidden
                ORDER BY threads.lastMessageDate DESC LIMIT ?
                """, arguments: [SystemLabel.inbox, limit])
        case let .label(accountID, labelID):
            return try MailThread.fetchAll(db, sql: """
                SELECT threads.* FROM threads
                JOIN threadLabels ON threadLabels.accountID = threads.accountID AND threadLabels.threadID = threads.id
                WHERE threadLabels.labelID = ? AND threads.accountID = ? AND NOT threads.isHidden
                ORDER BY threads.lastMessageDate DESC LIMIT ?
                """, arguments: [labelID, accountID, limit])
        case let .allMail(accountID):
            return try MailThread
                .filter(Column("accountID") == accountID && !Column("isHidden"))
                .order(Column("lastMessageDate").desc)
                .limit(limit)
                .fetchAll(db)
        }
    }
}

struct HistoryID: Comparable {
    let value: UInt64

    init(_ string: String) {
        value = UInt64(string) ?? 0
    }

    static func < (lhs: HistoryID, rhs: HistoryID) -> Bool { lhs.value < rhs.value }
}
