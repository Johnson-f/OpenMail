import Foundation

/// Keeps one account's local mail in step with Gmail: a full download, then history-based polling.
actor AccountSync {
    nonisolated let accountID: String
    private let gmail: any GmailAPI
    private let store: MailStore
    private let pollInterval: Duration
    private let fetchConcurrency = 8
    private let saveBatchSize = 50

    private var backfillTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var isSyncingChanges = false

    init(accountID: String, gmail: any GmailAPI, store: MailStore, pollInterval: Duration = .seconds(60)) {
        self.accountID = accountID
        self.gmail = gmail
        self.store = store
        self.pollInterval = pollInterval
    }

    func start() {
        guard pollTask == nil else { return }
        startBackfill()
        pollTask = Task {
            while !Task.isCancelled {
                await syncChangesRecordingErrors()
                try? await Task.sleep(for: pollInterval)
            }
        }
    }

    func stop() {
        backfillTask?.cancel()
        pollTask?.cancel()
        backfillTask = nil
        pollTask = nil
    }

    func syncNow() async {
        await syncChangesRecordingErrors()
    }

    private func startBackfill() {
        backfillTask?.cancel()
        backfillTask = Task {
            var delay = Duration.seconds(5)
            while !Task.isCancelled {
                do {
                    try await backfill()
                    return
                } catch {
                    guard await record(error) else { return }
                    try? await Task.sleep(for: delay)
                    delay = min(delay * 2, .seconds(300))
                }
            }
        }
    }

    private func syncChangesRecordingErrors() async {
        do {
            try await syncChanges()
            try await store.updateAccount(accountID) { $0.lastError = nil }
        } catch {
            _ = await record(error)
        }
    }

    // MARK: Full download

    func backfill() async throws {
        guard let account = try await store.account(accountID), !account.backfillComplete else { return }
        try await refreshLabels()
        let generation = account.syncGeneration
        var pageToken = account.backfillPageToken
        repeat {
            try Task.checkCancellation()
            let page = try await gmail.listMessages(pageToken: pageToken)
            let ids = (page.messages ?? []).map(\.id)
            let known = try await store.syncGenerations(of: ids, accountID: accountID)
            for batch in ids.chunked(into: saveBatchSize) {
                let missing = batch.filter { known[$0] == nil }
                let stale = batch.filter { (known[$0] ?? generation) < generation }
                try await store.saveMessages(try await fetch(missing, format: .full).map(parse), generation: generation)
                try await saveLabels(of: try await fetch(stale, format: .minimal), generation: generation)
            }
            pageToken = page.nextPageToken
            let nextToken = pageToken
            try await store.updateAccount(accountID) {
                $0.backfillPageToken = nextToken
                $0.backfillComplete = nextToken == nil
            }
        } while pageToken != nil
        try await store.deleteMessages(accountID: accountID, olderThanGeneration: generation)
    }

    // MARK: Incremental changes

    private enum Change {
        case added
        case labelsChanged
        case deleted
    }

    func syncChanges() async throws {
        guard !isSyncingChanges else { return }
        isSyncingChanges = true
        defer { isSyncingChanges = false }

        guard let account = try await store.account(accountID), let startHistoryID = account.historyID else { return }
        try await refreshLabels()

        var changes: [String: Change] = [:]
        var latestHistoryID = startHistoryID
        var pageToken: String?
        do {
            repeat {
                let page = try await gmail.history(startHistoryID: startHistoryID, pageToken: pageToken)
                for record in page.history ?? [] {
                    for event in record.messagesAdded ?? [] { changes[event.message.id] = .added }
                    for event in (record.labelsAdded ?? []) + (record.labelsRemoved ?? []) where changes[event.message.id] == nil {
                        changes[event.message.id] = .labelsChanged
                    }
                    for event in record.messagesDeleted ?? [] { changes[event.message.id] = .deleted }
                }
                latestHistoryID = page.historyId
                pageToken = page.nextPageToken
            } while pageToken != nil
        } catch GmailError.historyExpired {
            try await beginFullResync()
            return
        }

        let generation = account.syncGeneration
        let deleted = changes.filter { $0.value == .deleted }.map(\.key)
        let labelChanged = changes.filter { $0.value == .labelsChanged }.map(\.key)
        let known = try await store.syncGenerations(of: labelChanged, accountID: accountID)
        let toFetchFully = changes.filter { $0.value == .added }.map(\.key) + labelChanged.filter { known[$0] == nil }
        let toRelabel = labelChanged.filter { known[$0] != nil }

        try await store.deleteMessages(deleted, accountID: accountID)
        for batch in toFetchFully.chunked(into: saveBatchSize) {
            try await store.saveMessages(try await fetch(batch, format: .full).map(parse), generation: generation)
        }
        try await saveLabels(of: try await fetch(toRelabel, format: .minimal), generation: generation)
        let newHistoryID = latestHistoryID
        try await store.updateAccount(accountID) { $0.historyID = newHistoryID }
    }

    private func beginFullResync() async throws {
        let profile = try await gmail.profile()
        try await store.updateAccount(accountID) {
            $0.historyID = profile.historyId
            $0.messagesTotal = profile.messagesTotal ?? $0.messagesTotal
            $0.syncGeneration += 1
            $0.backfillPageToken = nil
            $0.backfillComplete = false
        }
        startBackfill()
    }

    // MARK: Helpers

    private func refreshLabels() async throws {
        let labels = try await gmail.labels().map {
            MailLabel(accountID: accountID, id: $0.id, name: $0.name, isSystem: $0.type == "system")
        }
        try await store.replaceLabels(labels, accountID: accountID)
    }

    private func parse(_ message: GmailMessage) -> ParsedMessage {
        MessageParser.parse(message, accountID: accountID)
    }

    private func saveLabels(of messages: [GmailMessage], generation: Int) async throws {
        for message in messages {
            try await store.updateLabels(
                messageID: message.id,
                accountID: accountID,
                labelIDs: message.labelIds ?? [],
                historyID: message.historyId,
                generation: generation
            )
        }
    }

    /// Fetches messages with bounded concurrency, skipping any deleted since they were listed.
    private func fetch(_ ids: [String], format: GmailMessageFormat) async throws -> [GmailMessage] {
        guard !ids.isEmpty else { return [] }
        let gmail = self.gmail
        return try await withThrowingTaskGroup(of: GmailMessage?.self) { group in
            var pending = ids.makeIterator()
            func addNext() {
                guard let id = pending.next() else { return }
                group.addTask {
                    do {
                        return try await gmail.message(id: id, format: format)
                    } catch GmailError.notFound {
                        return nil
                    }
                }
            }
            for _ in 0..<fetchConcurrency { addNext() }
            var results: [GmailMessage] = []
            while let result = try await group.next() {
                if let result { results.append(result) }
                addNext()
            }
            return results
        }
    }

    /// Records a failure on the account. Returns false when syncing should stop.
    private func record(_ error: any Error) async -> Bool {
        if error is CancellationError { return false }
        if case AuthError.reauthenticationRequired = error {
            try? await store.updateAccount(accountID) { $0.needsReauth = true }
            stop()
            return false
        }
        let description = String(describing: error)
        try? await store.updateAccount(accountID) { $0.lastError = description }
        return true
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
