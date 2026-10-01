import Foundation
@testable import OpenMailKit
import Testing

/// Embeds text as a bag of known words so semantic similarity is predictable in tests.
struct FakeEmbeddings: EmbeddingProvider {
    static let vocabulary = ["deposit", "landlord", "rent", "flat", "invoice", "payment", "lunch", "pizza", "money", "apartment"]
    static let synonyms = ["money": "payment", "apartment": "flat"]

    let model = "fake"

    func embed(_ texts: [String], inputType: EmbeddingInputType) async throws -> [[Float]] {
        texts.map { text in
            let words = text.lowercased().split(whereSeparator: { !$0.isLetter }).map { Self.synonyms[String($0)] ?? String($0) }
            return Self.vocabulary.map { term in Float(words.filter { $0 == term }.count) + 0.01 }
        }
    }
}

struct ChunkerTests {
    @Test func dropsQuotedHistoryAndKeepsHeaders() throws {
        let message = Message(
            accountID: "me@example.com", id: "m1", threadID: "t1", historyID: "1",
            date: Date(timeIntervalSince1970: 1_700_000_000), labelIDs: [], snippet: "",
            subject: "Deposit", from: EmailAddress(name: "Landlord", email: "ll@example.com"),
            to: [EmailAddress(email: "me@example.com")], cc: [], replyTo: [], messageIDHeader: nil, references: nil,
            bodyText: "We'll return the deposit Friday.\n\nOn Mon, 1 Jan 2024, Me <me@example.com>\nwrote:\n> When is my deposit back?",
            bodyHTML: nil
        )
        let chunks = Chunker.chunks(for: message)
        #expect(chunks.count == 1)
        let chunk = try #require(chunks.first)
        #expect(chunk.hasPrefix("From: Landlord <ll@example.com>\nTo: me@example.com\nDate: "))
        #expect(chunk.contains("Subject: Deposit"))
        #expect(chunk.hasSuffix("We'll return the deposit Friday."))
    }

    @Test func splitsLongBodiesIntoBoundedChunks() {
        let paragraph = String(repeating: "This sentence is filler text. ", count: 40)
        var message = OutgoingMessageTests().original
        message.bodyText = Array(repeating: paragraph, count: 6).joined(separator: "\n\n")
        let chunks = Chunker.chunks(for: message)
        #expect(chunks.count > 3)
        let header = Chunker.header(for: message)
        #expect(chunks.allSatisfy { $0.count <= header.count + 2 + Chunker.targetLength })
    }
}

struct SearchTests {
    let gmail = FakeGmail()
    let store: MailStore
    let accountID = "me@example.com"

    init() async throws {
        store = try MailStore.inMemory()
        gmail.add(Fixtures.message(id: "m1", thread: "t1", from: "Landlord <ll@example.com>", subject: "Your flat", body: "The deposit for the flat will be returned next week."), recordHistory: false)
        gmail.add(Fixtures.message(id: "m2", thread: "t2", from: "Bob <bob@example.com>", subject: "Lunch", body: "Pizza on Friday?"), recordHistory: false)
        gmail.add(Fixtures.message(id: "m3", thread: "t3", from: "Billing <billing@acme.com>", subject: "Invoice 4471", body: "Payment received for invoice 4471."), recordHistory: false)
        try await store.saveAccount(Account(id: accountID, historyID: "1", messagesTotal: 3))
        try await AccountSync(accountID: accountID, gmail: gmail, store: store).backfill()
    }

    private func search(_ query: String, embeddings: (any EmbeddingProvider)? = nil, filters: SearchFilters = SearchFilters()) async throws -> [String] {
        if let embeddings {
            let indexer = EmbeddingIndexer(store: store, provider: embeddings)
            while try await indexer.indexNextBatch() {}
        }
        let search = MailSearch(store: store, vectors: VectorIndex(store: store), embeddings: embeddings)
        return try await search.search(query, filters: filters).map(\.message.id)
    }

    @Test func keywordSearchMatchesSubjectSenderAndBody() async throws {
        #expect(try await search("4471") == ["m3"])
        #expect(try await search("landlord") == ["m1"])
        #expect(try await search("pizz") == ["m2"])
        #expect(try await search("billing@acme.com") == ["m3"])
    }

    @Test func keywordSearchFallsBackToAnyTermWhenAllTermsMiss() async throws {
        #expect(try await search("pizza deposit").sorted() == ["m1", "m2"])
    }

    @Test func semanticSearchFindsSynonyms() async throws {
        #expect(try await search("money", embeddings: FakeEmbeddings()).first == "m3")
        #expect(try await search("apartment", embeddings: FakeEmbeddings()).first == "m1")
    }

    @Test func filtersApplyToBothSources() async throws {
        let filters = SearchFilters(from: "bob@")
        #expect(try await search("pizza flat", embeddings: FakeEmbeddings(), filters: filters) == ["m2"])
    }

    @Test func queryPunctuationCannotInjectFTSSyntax() async throws {
        #expect(try await search("\"flat\" OR NEAR(* -") == ["m1"])
    }

    @Test func deletingMessagesRemovesThemFromSearch() async throws {
        try await store.deleteMessages(["m3"], accountID: accountID)
        #expect(try await search("4471").isEmpty)
        #expect(try await store.pendingChunks(limit: 10).allSatisfy { $0.messageID != "m3" })
    }

    @Test func indexStatusCountsEmbeddedChunks() async throws {
        _ = try await search("flat", embeddings: FakeEmbeddings())
        var iterator = store.observeIndexStatus().makeAsyncIterator()
        let status = try #require(try await iterator.next())
        #expect(status.totalChunks == 3)
        #expect(status.embeddedChunks == 3)
        #expect(status.pendingChunks == 0)
    }
}
