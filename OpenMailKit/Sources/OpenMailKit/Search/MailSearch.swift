import Foundation

public struct SearchFilters: Hashable, Sendable {
    public var accountIDs: [String]?
    public var from: String?
    public var after: Date?
    public var before: Date?

    public init(accountIDs: [String]? = nil, from: String? = nil, after: Date? = nil, before: Date? = nil) {
        self.accountIDs = accountIDs
        self.from = from
        self.after = after
        self.before = before
    }
}

public struct SearchHit: Hashable, Sendable, Identifiable {
    public var message: Message
    public var excerpt: String

    public var id: String { "\(message.accountID)/\(message.id)" }
    public var threadRef: ThreadRef { ThreadRef(accountID: message.accountID, threadID: message.threadID) }
}

/// Hybrid search: FTS5 keyword matches fused with semantic matches by reciprocal rank.
struct MailSearch: Sendable {
    private static let candidateCount = 50
    private static let rankConstant = 60.0

    let store: MailStore
    let vectors: VectorIndex
    let embeddings: (any EmbeddingProvider)?

    func search(_ query: String, filters: SearchFilters = SearchFilters(), limit: Int = 20) async throws -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        async let keyword = keywordCandidates(trimmed, filters: filters)
        async let semantic = semanticCandidates(trimmed, filters: filters)
        let keywordHits = try await keyword
        let semanticHits = (try? await semantic) ?? []

        var scores: [MessageKey: Double] = [:]
        var excerpts: [MessageKey: String] = [:]
        for (rank, hit) in keywordHits.enumerated() {
            let key = MessageKey(accountID: hit.accountID, messageID: hit.messageID)
            scores[key, default: 0] += 1 / (Self.rankConstant + Double(rank + 1))
            excerpts[key] = excerpts[key] ?? hit.excerpt
        }
        for (rank, hit) in semanticHits.enumerated() {
            scores[hit.key, default: 0] += 1 / (Self.rankConstant + Double(rank + 1))
            if excerpts[hit.key]?.isEmpty ?? true { excerpts[hit.key] = hit.excerpt }
        }

        let ranked = scores.sorted { $0.value > $1.value }.prefix(limit).map(\.key)
        let messages = try await store.messages(keys: ranked.map { ($0.accountID, $0.messageID) }, filters: filters)
        let byKey = Dictionary(uniqueKeysWithValues: messages.map { (MessageKey(accountID: $0.accountID, messageID: $0.id), $0) })
        return ranked.compactMap { key in
            byKey[key].map { SearchHit(message: $0, excerpt: excerpts[key] ?? $0.snippet) }
        }
    }

    private func keywordCandidates(_ query: String, filters: SearchFilters) async throws -> [KeywordHit] {
        var terms = Self.terms(in: query)
        guard !terms.isEmpty else { return [] }
        terms[terms.count - 1] += "*"
        let all = try await store.keywordSearch(terms.joined(separator: " AND "), filters: filters, limit: Self.candidateCount)
        guard terms.count > 1, all.count < 10 else { return all }
        let any = try await store.keywordSearch(terms.joined(separator: " OR "), filters: filters, limit: Self.candidateCount)
        let seen = Set(all.map { "\($0.accountID)/\($0.messageID)" })
        return all + any.filter { !seen.contains("\($0.accountID)/\($0.messageID)") }
    }

    private struct SemanticHit {
        var key: MessageKey
        var excerpt: String
    }

    private func semanticCandidates(_ query: String, filters: SearchFilters) async throws -> [SemanticHit] {
        guard let embeddings else { return [] }
        guard let vector = try await embeddings.embed([query], inputType: .query).first else { return [] }
        try await vectors.refresh()
        let nearest = await vectors.nearest(to: vector, limit: Self.candidateCount * 3, accountIDs: filters.accountIDs.map(Set.init))
        let chunks = Dictionary(uniqueKeysWithValues: try await store.chunks(ids: nearest.map(\.chunkID)).compactMap { chunk in
            chunk.id.map { ($0, chunk) }
        })
        var seen = Set<MessageKey>()
        var hits: [SemanticHit] = []
        for match in nearest {
            guard let chunk = chunks[match.chunkID] else { continue }
            let key = MessageKey(accountID: chunk.accountID, messageID: chunk.messageID)
            guard seen.insert(key).inserted else { continue }
            hits.append(SemanticHit(key: key, excerpt: Self.excerpt(fromChunk: chunk.text)))
            if hits.count == Self.candidateCount { break }
        }
        return hits
    }

    /// Converts free text into FTS5 terms, quoting each word so punctuation can't form query syntax.
    static func terms(in query: String) -> [String] {
        query
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "@" && $0 != "." && $0 != "-" && $0 != "_" })
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".-_")) }
            .filter { !$0.isEmpty }
            .map { "\"\($0.replacingOccurrences(of: "\"", with: ""))\"" }
    }

    private static func excerpt(fromChunk text: String) -> String {
        let body = text.components(separatedBy: "\n\n").dropFirst().joined(separator: " ")
        let flattened = body.replacing(/\s+/, with: " ")
        return flattened.count > 280 ? String(flattened.prefix(280)) + "…" : flattened
    }
}

struct MessageKey: Hashable, Sendable {
    var accountID: String
    var messageID: String
}
