import Foundation
import GRDB

struct Chunk: Codable, FetchableRecord, PersistableRecord, Sendable {
    static let databaseTableName = "chunks"

    var id: Int64?
    var accountID: String
    var messageID: String
    var threadID: String
    var text: String
    var embedding: Data?
    var embeddingModel: String?
    var failed: Bool
}

struct EmbeddedChunk: Sendable {
    var id: Int64
    var accountID: String
    var embedding: [Float]
}

struct KeywordHit: Sendable {
    var accountID: String
    var messageID: String
    var excerpt: String
}

public struct IndexStatus: Hashable, Sendable {
    public var totalChunks: Int
    public var embeddedChunks: Int
    public var failedChunks: Int
    public var lastError: String?

    public var pendingChunks: Int { totalChunks - embeddedChunks - failedChunks }
}

extension MailStore {
    static func registerSearchMigrations(_ migrator: inout DatabaseMigrator) {
        migrator.registerMigration("v2-search") { db in
            try db.execute(sql: """
                CREATE VIRTUAL TABLE messages_fts USING fts5(
                    subject, sender, recipients, body,
                    tokenize = 'porter unicode61 remove_diacritics 2'
                );
                CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
                    DELETE FROM messages_fts WHERE rowid = old.rowid;
                END;
                """)
            try db.create(table: "chunks") { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("accountID", .text).notNull()
                t.column("messageID", .text).notNull()
                t.column("threadID", .text).notNull()
                t.column("text", .text).notNull()
                t.column("embedding", .blob)
                t.column("embeddingModel", .text)
                t.column("failed", .boolean).notNull().defaults(to: false)
                t.foreignKey(["accountID", "messageID"], references: "messages", onDelete: .cascade)
            }
            try db.create(index: "chunks_message", on: "chunks", columns: ["accountID", "messageID"])
            try db.execute(sql: "CREATE INDEX chunks_pending ON chunks(id) WHERE embedding IS NULL AND NOT failed")
            try db.create(table: "appState") { t in
                t.primaryKey("key", .text)
                t.column("value", .text)
            }

            let rows = try Row.fetchCursor(db, sql: "SELECT rowid, * FROM messages")
            while let row = try rows.next() {
                try indexForSearch(try Message(row: row), rowID: row["rowid"], db: db)
            }
        }
    }

    /// Adds a newly stored message to the keyword index and queues its passages for embedding.
    static func indexForSearch(_ message: Message, rowID: Int64, db: Database) throws {
        let recipients = (message.to + message.cc).map(searchText).joined(separator: " ")
        try db.execute(
            sql: "INSERT INTO messages_fts(rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
            arguments: [rowID, message.subject, message.from.map(searchText) ?? "", recipients, message.bodyText]
        )
        for text in Chunker.chunks(for: message) {
            let chunk = Chunk(
                accountID: message.accountID,
                messageID: message.id,
                threadID: message.threadID,
                text: text,
                failed: false
            )
            try chunk.insert(db)
        }
    }

    private static func searchText(_ address: EmailAddress) -> String {
        [address.name, address.email].compactMap { $0 }.joined(separator: " ")
    }

    // MARK: Embedding queue

    func pendingChunks(limit: Int) async throws -> [Chunk] {
        try await db.read { db in
            try Chunk.fetchAll(db, sql: "SELECT * FROM chunks WHERE embedding IS NULL AND NOT failed ORDER BY id LIMIT ?", arguments: [limit])
        }
    }

    func saveEmbeddings(_ embeddings: [(id: Int64, vector: [Float])], model: String) async throws {
        try await db.write { db in
            for (id, vector) in embeddings {
                try db.execute(
                    sql: "UPDATE chunks SET embedding = ?, embeddingModel = ? WHERE id = ?",
                    arguments: [Data(floats: vector), model, id]
                )
            }
        }
    }

    func markChunksFailed(_ ids: [Int64]) async throws {
        try await db.write { db in
            try db.execute(sql: "UPDATE chunks SET failed = 1 WHERE id IN (\(ids.map(String.init).joined(separator: ",")))")
        }
    }

    func embeddedChunks(after id: Int64) async throws -> [EmbeddedChunk] {
        try await db.read { db in
            let rows = try Row.fetchCursor(
                db,
                sql: "SELECT id, accountID, embedding FROM chunks WHERE embedding IS NOT NULL AND id > ? ORDER BY id",
                arguments: [id]
            )
            var chunks: [EmbeddedChunk] = []
            while let row = try rows.next() {
                let data: Data = row["embedding"]
                chunks.append(EmbeddedChunk(id: row["id"], accountID: row["accountID"], embedding: data.floats()))
            }
            return chunks
        }
    }

    func chunks(ids: [Int64]) async throws -> [Chunk] {
        guard !ids.isEmpty else { return [] }
        return try await db.read { db in try Chunk.filter(keys: ids).fetchAll(db) }
    }

    func setAppState(_ key: String, _ value: String?) async throws {
        try await db.write { db in
            try db.execute(sql: "INSERT OR REPLACE INTO appState(key, value) VALUES (?, ?)", arguments: [key, value])
        }
    }

    public func observeIndexStatus() -> AsyncValueObservation<IndexStatus> {
        ValueObservation
            .tracking { db in
                let row = try Row.fetchOne(db, sql: """
                    SELECT COUNT(*) AS total,
                           COUNT(embedding) AS embedded,
                           COALESCE(SUM(failed), 0) AS failed
                    FROM chunks
                    """)!
                let error = try String.fetchOne(db, sql: "SELECT value FROM appState WHERE key = 'indexError'")
                return IndexStatus(totalChunks: row["total"], embeddedChunks: row["embedded"], failedChunks: row["failed"], lastError: error)
            }
            .removeDuplicates()
            .values(in: db)
    }

    // MARK: Keyword search

    func keywordSearch(_ ftsQuery: String, filters: SearchFilters, limit: Int) async throws -> [KeywordHit] {
        try await db.read { db in
            var sql = """
                SELECT m.accountID, m.id, snippet(messages_fts, 3, '', '', '…', 32) AS excerpt
                FROM messages_fts
                JOIN messages m ON m.rowid = messages_fts.rowid
                WHERE messages_fts MATCH ?
                """
            var arguments: StatementArguments = [ftsQuery]
            Self.appendFilters(filters, to: &sql, arguments: &arguments)
            sql += " ORDER BY bm25(messages_fts, 6.0, 4.0, 1.0, 1.0) LIMIT ?"
            arguments += [limit]
            return try Row.fetchAll(db, sql: sql, arguments: arguments).map {
                KeywordHit(accountID: $0["accountID"], messageID: $0["id"], excerpt: $0["excerpt"])
            }
        }
    }

    func messages(keys: [(accountID: String, messageID: String)], filters: SearchFilters) async throws -> [Message] {
        guard !keys.isEmpty else { return [] }
        return try await db.read { db in
            var sql = "SELECT m.* FROM messages m WHERE (\(keys.map { _ in "(m.accountID = ? AND m.id = ?)" }.joined(separator: " OR ")))"
            var arguments = StatementArguments(keys.flatMap { [$0.accountID, $0.messageID] })
            Self.appendFilters(filters, to: &sql, arguments: &arguments)
            return try Message.fetchAll(db, sql: sql, arguments: arguments)
        }
    }

    func message(accountID: String, messageID: String) async throws -> Message? {
        try await db.read { try Message.fetchOne($0, key: ["accountID": accountID, "id": messageID]) }
    }

    func recentThreads(accountIDs: [String]?, labelID: String?, unreadOnly: Bool, after: Date?, before: Date?, limit: Int) async throws -> [MailThread] {
        try await db.read { db in
            var sql = "SELECT t.* FROM threads t WHERE NOT t.isHidden"
            var arguments: StatementArguments = []
            if let labelID {
                sql += " AND EXISTS (SELECT 1 FROM threadLabels l WHERE l.accountID = t.accountID AND l.threadID = t.id AND l.labelID = ?)"
                arguments += [labelID]
            }
            if let accountIDs {
                sql += " AND t.accountID IN (\(accountIDs.map { _ in "?" }.joined(separator: ",")))"
                arguments += StatementArguments(accountIDs)
            }
            if unreadOnly { sql += " AND t.isUnread" }
            if let after {
                sql += " AND t.lastMessageDate >= ?"
                arguments += [after]
            }
            if let before {
                sql += " AND t.lastMessageDate < ?"
                arguments += [before]
            }
            sql += " ORDER BY t.lastMessageDate DESC LIMIT ?"
            arguments += [limit]
            return try MailThread.fetchAll(db, sql: sql, arguments: arguments)
        }
    }

    private static func appendFilters(_ filters: SearchFilters, to sql: inout String, arguments: inout StatementArguments) {
        if let accountIDs = filters.accountIDs {
            sql += " AND m.accountID IN (\(accountIDs.map { _ in "?" }.joined(separator: ",")))"
            arguments += StatementArguments(accountIDs)
        }
        if let from = filters.from, !from.isEmpty {
            sql += " AND m.\"from\" LIKE ?"
            arguments += ["%\(from)%"]
        }
        if let after = filters.after {
            sql += " AND m.date >= ?"
            arguments += [after]
        }
        if let before = filters.before {
            sql += " AND m.date < ?"
            arguments += [before]
        }
    }
}

extension Data {
    init(floats: [Float]) {
        self = floats.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    func floats() -> [Float] {
        var floats = [Float](repeating: 0, count: count / MemoryLayout<Float>.size)
        _ = floats.withUnsafeMutableBytes { copyBytes(to: $0) }
        return floats
    }
}
