import Foundation

/// Embeds queued message passages in the background whenever a Voyage key is configured.
actor EmbeddingIndexer {
    private let store: MailStore
    private let provider: any EmbeddingProvider
    private let batchSize: Int
    private let idleInterval: Duration
    private var task: Task<Void, Never>?

    init(store: MailStore, provider: any EmbeddingProvider, batchSize: Int = 128, idleInterval: Duration = .seconds(15)) {
        self.store = store
        self.provider = provider
        self.batchSize = batchSize
        self.idleInterval = idleInterval
    }

    func start() {
        guard task == nil else { return }
        task = Task { await run() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func run() async {
        var backoff = Duration.seconds(5)
        while !Task.isCancelled {
            do {
                let embeddedAny = try await indexNextBatch()
                try await store.setAppState("indexError", nil)
                backoff = .seconds(5)
                if !embeddedAny { try await Task.sleep(for: idleInterval) }
            } catch is CancellationError {
                return
            } catch {
                try? await store.setAppState("indexError", error.localizedDescription)
                let isAuthFailure = (error as? VoyageError).map {
                    if case let .http(status, _) = $0 { return status == 401 || status == 403 }
                    return false
                } ?? false
                try? await Task.sleep(for: isAuthFailure ? .seconds(300) : backoff)
                backoff = min(backoff * 2, .seconds(300))
            }
        }
    }

    /// Returns whether there was anything to embed.
    func indexNextBatch() async throws -> Bool {
        let chunks = try await store.pendingChunks(limit: batchSize)
        guard !chunks.isEmpty else { return false }
        do {
            let vectors = try await provider.embed(chunks.map(\.text), inputType: .document)
            try await store.saveEmbeddings(zip(chunks.compactMap(\.id), vectors).map { ($0, $1) }, model: provider.model)
        } catch let VoyageError.http(status, _) where status == 400 {
            try await store.markChunksFailed(chunks.compactMap(\.id))
        }
        return true
    }
}
