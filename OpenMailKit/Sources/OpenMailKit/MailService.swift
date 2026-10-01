import Foundation

public enum AssistantEngine: String, Sendable, CaseIterable {
    /// The user's own Codex install, billed to their ChatGPT plan.
    case codex
    /// An Anthropic API key entered in Settings.
    case anthropicAPI
}

public actor MailService {
    public nonisolated let store: MailStore
    private let oauth: GoogleOAuth
    private let tokenStore: any TokenStore
    private let apiKeys: any APIKeyStore
    private let transport: URLSessionTransport
    private let vectors: VectorIndex
    private var clients: [String: any GmailAPI] = [:]
    private var syncs: [String: AccountSync] = [:]
    private var indexer: EmbeddingIndexer?

    public init(
        config: GoogleOAuthConfig,
        store: MailStore,
        tokenStore: any TokenStore = KeychainTokenStore(),
        apiKeys: any APIKeyStore = KeychainAPIKeyStore(),
        transport: URLSessionTransport = URLSessionTransport()
    ) {
        self.store = store
        self.oauth = GoogleOAuth(config: config, transport: transport)
        self.tokenStore = tokenStore
        self.apiKeys = apiKeys
        self.transport = transport
        self.vectors = VectorIndex(store: store)
    }

    /// Resumes syncing every account that has a stored refresh token, and background indexing.
    public func start() async throws {
        restartIndexer()
        for account in try await store.accounts() {
            guard let refreshToken = try tokenStore.refreshToken(for: account.id) else {
                try await store.updateAccount(account.id) { $0.needsReauth = true }
                continue
            }
            await connect(account.id, tokens: GoogleTokenProvider(oauth: oauth, refreshToken: refreshToken))
        }
    }

    /// Opens Google sign-in in the browser and adds (or re-authorizes) the chosen account.
    @discardableResult
    public func addAccount(openURL: @Sendable (URL) async -> Void) async throws -> String {
        let (refreshToken, accessToken) = try await oauth.signIn(openURL: openURL)
        let tokens = GoogleTokenProvider(oauth: oauth, refreshToken: refreshToken, initial: accessToken)
        let profile = try await GmailClient(transport: transport, tokens: tokens).profile()
        let accountID = profile.emailAddress
        try tokenStore.setRefreshToken(refreshToken, for: accountID)

        if try await store.account(accountID) != nil {
            try await store.updateAccount(accountID) {
                $0.needsReauth = false
                $0.lastError = nil
            }
        } else {
            try await store.saveAccount(Account(id: accountID, historyID: profile.historyId, messagesTotal: profile.messagesTotal ?? 0))
        }
        await syncs[accountID]?.stop()
        await connect(accountID, tokens: tokens)
        return accountID
    }

    public func removeAccount(_ accountID: String) async throws {
        await syncs.removeValue(forKey: accountID)?.stop()
        clients[accountID] = nil
        try tokenStore.removeRefreshToken(for: accountID)
        try await store.deleteAccount(accountID)
    }

    public func syncNow() async {
        for sync in syncs.values { await sync.syncNow() }
    }

    // MARK: Actions

    public func archive(_ ref: ThreadRef) async throws {
        try await modify(ref, add: [], remove: [SystemLabel.inbox])
    }

    public func moveToInbox(_ ref: ThreadRef) async throws {
        try await modify(ref, add: [SystemLabel.inbox], remove: [])
    }

    public func setStarred(_ starred: Bool, _ ref: ThreadRef) async throws {
        try await modify(ref, add: starred ? [SystemLabel.starred] : [], remove: starred ? [] : [SystemLabel.starred])
    }

    public func setUnread(_ unread: Bool, _ ref: ThreadRef) async throws {
        try await modify(ref, add: unread ? [SystemLabel.unread] : [], remove: unread ? [] : [SystemLabel.unread])
    }

    public func trash(_ ref: ThreadRef) async throws {
        try await client(ref.accountID).trashThread(id: ref.threadID)
        try await store.applyLabelChange(ref, add: [SystemLabel.trash], remove: [SystemLabel.inbox])
    }

    public func send(_ message: OutgoingMessage) async throws {
        _ = try await client(message.accountID).send(raw: message.rfc822(), threadID: message.threadID)
        await syncs[message.accountID]?.syncNow()
    }

    /// Downloads an attachment to a temporary file and returns its URL.
    public func download(_ attachment: Attachment) async throws -> URL {
        let data = try await client(attachment.accountID).attachment(
            messageID: attachment.messageID,
            attachmentID: attachment.gmailAttachmentID
        )
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "OpenMail Attachments")
            .appending(path: "\(attachment.messageID)-\(attachment.partID)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = attachment.filename.replacingOccurrences(of: "/", with: "-")
        let url = directory.appending(path: safeName.isEmpty ? "attachment" : safeName)
        try data.write(to: url)
        return url
    }

    // MARK: Search and assistant

    public nonisolated func hasAPIKey(_ kind: APIKeyKind) -> Bool {
        (try? apiKeys.key(kind)) != nil
    }

    /// Checks the key with a cheap request, then stores it in the Keychain. An empty key removes it.
    public func setAPIKey(_ key: String, for kind: APIKeyKind) async throws {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            switch kind {
            case .anthropic: try await ClaudeClient(apiKey: trimmed, transport: transport).validateKey(using: transport)
            case .voyage: _ = try await VoyageClient(apiKey: trimmed, transport: transport).embed(["OpenMail"], inputType: .query)
            }
        }
        try apiKeys.setKey(trimmed, for: kind)
        if kind == .voyage { restartIndexer() }
    }

    public func search(_ query: String, filters: SearchFilters = SearchFilters(), limit: Int = 20) async throws -> [SearchHit] {
        try await mailSearch().search(query, filters: filters, limit: limit)
    }

    public func makeAssistant(engine: AssistantEngine) async throws -> any AssistantBackend {
        let toolbox = MailToolbox(store: store, search: mailSearch())
        switch engine {
        case .codex:
            guard let cli = await CodexCLI.locate() else { throw CodexError.notInstalled }
            return CodexSession(cli: cli, toolbox: toolbox, directory: Self.codexDirectory)
        case .anthropicAPI:
            guard let key = try apiKeys.key(.anthropic) else { throw ClaudeError.missingAPIKey }
            return AssistantSession(client: ClaudeClient(apiKey: key, transport: transport), toolbox: toolbox)
        }
    }

    public nonisolated func codexStatus() async -> CodexStatus {
        guard let cli = await CodexCLI.locate() else {
            return CodexStatus(executable: nil, isLoggedIn: false, problem: CodexError.notInstalled.errorDescription)
        }
        return await cli.status()
    }

    /// A folder owned by OpenMail, so Codex never picks up a project's AGENTS.md or config.
    private static var codexDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "OpenMail/Codex")
    }

    private func mailSearch() -> MailSearch {
        let embeddings = (try? apiKeys.key(.voyage)).flatMap { $0 }.map { VoyageClient(apiKey: $0, transport: transport) }
        return MailSearch(store: store, vectors: vectors, embeddings: embeddings)
    }

    private func restartIndexer() {
        let previous = indexer
        indexer = nil
        Task { await previous?.stop() }
        guard let key = try? apiKeys.key(.voyage) else { return }
        let indexer = EmbeddingIndexer(store: store, provider: VoyageClient(apiKey: key, transport: transport))
        self.indexer = indexer
        Task { await indexer.start() }
    }

    // MARK: Private

    private func connect(_ accountID: String, tokens: any AccessTokenProvider) async {
        let client = GmailClient(transport: transport, tokens: tokens)
        let sync = AccountSync(accountID: accountID, gmail: client, store: store)
        clients[accountID] = client
        syncs[accountID] = sync
        await sync.start()
    }

    private func client(_ accountID: String) throws -> any GmailAPI {
        guard let client = clients[accountID] else { throw AuthError.reauthenticationRequired }
        return client
    }

    private func modify(_ ref: ThreadRef, add: [String], remove: [String]) async throws {
        try await client(ref.accountID).modifyThread(id: ref.threadID, add: add, remove: remove)
        try await store.applyLabelChange(ref, add: add, remove: remove)
    }
}
