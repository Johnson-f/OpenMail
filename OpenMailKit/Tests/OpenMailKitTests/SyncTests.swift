import Foundation
@testable import OpenMailKit
import Testing

struct SyncTests {
    let gmail = FakeGmail()
    let store: MailStore
    let accountID = "me@example.com"

    init() async throws {
        store = try MailStore.inMemory()
    }

    private func makeSync() async throws -> AccountSync {
        let profile = try await gmail.profile()
        try await store.saveAccount(Account(id: accountID, historyID: profile.historyId, messagesTotal: 0))
        return AccountSync(accountID: accountID, gmail: gmail, store: store)
    }

    private func inbox() async throws -> [MailThread] {
        try await store.threads(in: .label(accountID: accountID, labelID: "INBOX"), limit: 100)
    }

    @Test func backfillDownloadsEveryPageAndBuildsThreads() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1", date: 1_000), recordHistory: false)
        gmail.add(Fixtures.message(id: "m2", thread: "t1", from: "me@example.com", subject: "Re: Hello", labels: ["SENT"], date: 2_000), recordHistory: false)
        gmail.add(Fixtures.message(id: "m3", thread: "t2", from: "Bob <bob@example.com>", date: 3_000), recordHistory: false)
        let sync = try await makeSync()

        try await sync.backfill()

        let threads = try await inbox()
        #expect(threads.map(\.id) == ["t2", "t1"])
        let t1 = try #require(threads.last)
        #expect(t1.subject == "Hello")
        #expect(t1.messageCount == 2)
        #expect(t1.participants == "Alice, me")
        #expect(t1.isUnread)
        #expect(try await store.account(accountID)?.backfillComplete == true)
        #expect(try await store.threads(in: .allInboxes, limit: 10).count == 2)
    }

    @Test func incrementalSyncAppliesAddsLabelChangesAndDeletes() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1"), recordHistory: false)
        gmail.add(Fixtures.message(id: "m2", thread: "t2"), recordHistory: false)
        let sync = try await makeSync()
        try await sync.backfill()

        gmail.add(Fixtures.message(id: "m3", thread: "t3"))
        gmail.setLabels("m1", ["INBOX"])
        gmail.delete("m2")
        try await sync.syncChanges()

        let threads = try await inbox()
        #expect(Set(threads.map(\.id)) == ["t1", "t3"])
        #expect(threads.first { $0.id == "t1" }?.isUnread == false)
        #expect(try await store.account(accountID)?.historyID == String(gmail.state.withLockUnchecked { $0.historyID }))
    }

    @Test func archivedMessageLeavesInbox() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1"), recordHistory: false)
        let sync = try await makeSync()
        try await sync.backfill()

        gmail.setLabels("m1", ["UNREAD"])
        try await sync.syncChanges()

        #expect(try await inbox().isEmpty)
        #expect(try await store.threads(in: .allMail(accountID: accountID), limit: 10).map(\.id) == ["t1"])
    }

    @Test func staleBackfillCopyDoesNotOverwriteNewerLabels() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1"), recordHistory: false)
        let stale = try await gmail.message(id: "m1", format: .full)
        let sync = try await makeSync()
        try await sync.backfill()
        gmail.setLabels("m1", [])
        try await sync.syncChanges()

        try await store.saveMessages([MessageParser.parse(stale, accountID: accountID)], generation: 1)

        #expect(try await inbox().isEmpty)
    }

    @Test func expiredHistoryTriggersResyncThatRemovesDeletedMail() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1"), recordHistory: false)
        gmail.add(Fixtures.message(id: "m2", thread: "t2"), recordHistory: false)
        let sync = try await makeSync()
        try await sync.backfill()

        gmail.delete("m1")
        gmail.setLabels("m2", ["INBOX"])
        gmail.state.withLockUnchecked { $0.expiredBefore = Int.max }
        try await sync.syncChanges()
        gmail.state.withLockUnchecked { $0.expiredBefore = 0 }
        await sync.stop()
        try await sync.backfill()

        let threads = try await inbox()
        #expect(threads.map(\.id) == ["t2"])
        #expect(threads.first?.isUnread == false)
        #expect(try await store.account(accountID)?.syncGeneration == 2)
    }

    @Test func trashedThreadsAreHidden() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1"), recordHistory: false)
        let sync = try await makeSync()
        try await sync.backfill()

        try await store.applyLabelChange(ThreadRef(accountID: accountID, threadID: "t1"), add: ["TRASH"], remove: ["INBOX"])

        #expect(try await store.threads(in: .allMail(accountID: accountID), limit: 10).isEmpty)
    }

    @Test func removingAccountDeletesItsMail() async throws {
        gmail.add(Fixtures.message(id: "m1", thread: "t1"), recordHistory: false)
        let sync = try await makeSync()
        try await sync.backfill()

        try await store.deleteAccount(accountID)

        #expect(try await store.threads(in: .allInboxes, limit: 10).isEmpty)
        #expect(try await store.syncGenerations(of: ["m1"], accountID: accountID).isEmpty)
    }
}
