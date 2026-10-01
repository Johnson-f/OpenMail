import AppKit
import OpenMailKit
import SwiftUI

@MainActor
@Observable
final class AppModel {
    enum LaunchState {
        case ready(MailService)
        case failed(String)
    }

    let launchState: LaunchState
    var accounts: [Account] = []
    var hasLoadedAccounts = false
    var labels: [MailLabel] = []
    var messageCounts: [String: Int] = [:]
    var threads: [MailThread] = []
    var selectedThreadDetail: MailThread?
    var selectedMessages: [MessageWithAttachments] = []
    var compose: ComposeRequest?
    var errorMessage: String?
    var isAddingAccount = false
    var indexStatus: IndexStatus?
    var hasAnthropicKey = false
    var hasVoyageKey = false
    var codexStatus: CodexStatus?
    var assistantEngine: AssistantEngine = AppModel.savedEngine {
        didSet {
            guard assistantEngine != oldValue else { return }
            UserDefaults.standard.set(assistantEngine.rawValue, forKey: Self.engineKey)
            assistant.reset()
        }
    }
    var isAssistantVisible = false
    var isPaletteVisible = false
    let assistant = AssistantModel()

    var mailbox: Mailbox? = .allInboxes {
        didSet {
            guard mailbox != oldValue else { return }
            threadLimit = Self.pageSize
            selectedThread = nil
            observeThreads()
        }
    }

    var selectedThread: ThreadRef? {
        didSet {
            guard selectedThread != oldValue else { return }
            observeSelectedThread()
        }
    }

    private static let pageSize = 200
    private static let engineKey = "assistantEngine"

    private static var savedEngine: AssistantEngine {
        UserDefaults.standard.string(forKey: engineKey).flatMap(AssistantEngine.init) ?? .codex
    }
    private var threadLimit = AppModel.pageSize
    private var threadsTask: Task<Void, Never>?
    private var messagesTask: Task<Void, Never>?
    private var threadDetailTask: Task<Void, Never>?
    private var addAccountTask: Task<Void, Never>?

    private init(launchState: LaunchState) {
        self.launchState = launchState
    }

    static func launch() -> AppModel {
        guard let config = googleConfig() else {
            return AppModel(launchState: .failed(
                "Google OAuth credentials are missing. Run scripts/generate-secrets.sh, then rebuild."
            ))
        }
        do {
            let databaseURL = URL.applicationSupportDirectory.appending(path: "OpenMail/mail.sqlite")
            let service = MailService(config: config, store: try MailStore.open(at: databaseURL))
            let model = AppModel(launchState: .ready(service))
            model.start(service)
            return model
        } catch {
            return AppModel(launchState: .failed("Couldn't open the mail database: \(error.localizedDescription)"))
        }
    }

    private static func googleConfig() -> GoogleOAuthConfig? {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let id = info["GoogleClientID"] as? String, let secret = info["GoogleClientSecret"] as? String,
              !id.isEmpty, !secret.isEmpty, !id.hasPrefix("$(") else { return nil }
        return GoogleOAuthConfig(clientID: id, clientSecret: secret)
    }

    var service: MailService? {
        if case let .ready(service) = launchState { return service }
        return nil
    }

    private func start(_ service: MailService) {
        observe(service.store.observeAccounts()) {
            $0.accounts = $1
            $0.hasLoadedAccounts = true
        }
        observe(service.store.observeLabels()) { $0.labels = $1 }
        observe(service.store.observeMessageCounts()) { $0.messageCounts = $1 }
        observe(service.store.observeIndexStatus()) { $0.indexStatus = $1 }
        refreshKeyState()
        refreshCodexStatus()
        observeThreads()
        perform { try await service.start() }
    }

    // MARK: Observation

    @discardableResult
    private func observe<S: AsyncSequence & Sendable>(
        _ sequence: S,
        apply: @escaping @MainActor (AppModel, S.Element) -> Void
    ) -> Task<Void, Never> where S.Element: Sendable {
        Task { [weak self] in
            do {
                for try await value in sequence {
                    guard let self else { return }
                    apply(self, value)
                }
            } catch {
                self?.errorMessage = error.localizedDescription
            }
        }
    }

    private func observeThreads() {
        threadsTask?.cancel()
        guard let service, let mailbox else {
            threads = []
            return
        }
        threadsTask = observe(service.store.observeThreads(in: mailbox, limit: threadLimit)) { $0.threads = $1 }
    }

    private func observeSelectedThread() {
        messagesTask?.cancel()
        threadDetailTask?.cancel()
        selectedMessages = []
        selectedThreadDetail = nil
        guard let service, let ref = selectedThread else { return }
        messagesTask = observe(service.store.observeMessages(in: ref)) { $0.selectedMessages = $1 }
        var isFirstValue = true
        threadDetailTask = observe(service.store.observeThread(ref)) { model, thread in
            model.selectedThreadDetail = thread
            if isFirstValue, thread?.isUnread == true {
                model.perform { try await service.setUnread(false, ref) }
            }
            isFirstValue = false
        }
    }

    func loadMoreThreadsIfNeeded(after thread: MailThread) {
        guard thread.id == threads.last?.id, threads.count >= threadLimit else { return }
        threadLimit += Self.pageSize
        observeThreads()
    }

    // MARK: Accounts

    func addAccount() {
        guard let service, !isAddingAccount else { return }
        isAddingAccount = true
        addAccountTask = Task {
            defer { isAddingAccount = false }
            do {
                try await service.addAccount { url in
                    await MainActor.run { _ = NSWorkspace.shared.open(url) }
                }
                NSApp.activate()
            } catch is CancellationError {
            } catch {
                errorMessage = "Couldn't connect the account: \(error.localizedDescription)"
            }
        }
    }

    func cancelAddAccount() {
        addAccountTask?.cancel()
    }

    func removeAccount(_ accountID: String) {
        guard let service else { return }
        if case let .label(id, _) = mailbox, id == accountID { mailbox = .allInboxes }
        if case let .allMail(id) = mailbox, id == accountID { mailbox = .allInboxes }
        perform { try await service.removeAccount(accountID) }
    }

    func refresh() {
        guard let service else { return }
        Task { await service.syncNow() }
    }

    // MARK: Thread actions

    var selectedThreadSummary: MailThread? {
        selectedThreadDetail
    }

    func archiveSelection() {
        moveSelectionAway { try await $0.archive($1) }
    }

    func trashSelection() {
        moveSelectionAway { try await $0.trash($1) }
    }

    func toggleStarred() {
        guard let service, let thread = selectedThreadSummary else { return }
        perform { try await service.setStarred(!thread.isStarred, thread.ref) }
    }

    func toggleUnread() {
        guard let service, let thread = selectedThreadSummary else { return }
        perform { try await service.setUnread(!thread.isUnread, thread.ref) }
    }

    private func moveSelectionAway(_ action: @escaping @Sendable (MailService, ThreadRef) async throws -> Void) {
        guard let service, let ref = selectedThread else { return }
        if let index = threads.firstIndex(where: { $0.ref == ref }) {
            let remaining = threads.filter { $0.ref != ref }
            selectedThread = remaining.isEmpty ? nil : remaining[min(index, remaining.count - 1)].ref
        }
        perform { try await action(service, ref) }
    }

    // MARK: Compose

    func composeNew() {
        guard let accountID = defaultAccountID else { return }
        compose = ComposeRequest(draft: OutgoingMessage(accountID: accountID))
    }

    func reply(all: Bool) {
        guard let ref = selectedThread, let last = selectedMessages.last?.message else { return }
        compose = ComposeRequest(draft: .reply(to: last, accountID: ref.accountID, replyAll: all))
    }

    func reply(to message: Message, all: Bool) {
        compose = ComposeRequest(draft: .reply(to: message, accountID: message.accountID, replyAll: all))
    }

    func send(_ message: OutgoingMessage) async throws {
        guard let service else { return }
        try await service.send(message)
    }

    private var defaultAccountID: String? {
        switch mailbox {
        case let .label(accountID, _), let .allMail(accountID): accountID
        default: selectedThread?.accountID ?? accounts.first?.id
        }
    }

    // MARK: Attachments

    func open(_ attachment: Attachment) {
        guard let service else { return }
        perform {
            let url = try await service.download(attachment)
            await MainActor.run { _ = NSWorkspace.shared.open(url) }
        }
    }

    // MARK: Search and assistant

    func search(_ query: String) async throws -> [SearchHit] {
        guard let service else { return [] }
        return try await service.search(query, limit: 25)
    }

    func open(_ ref: ThreadRef) {
        selectedThread = ref
    }

    func openCitation(_ key: String) {
        guard let target = assistant.citations[key] else { return }
        selectedThread = target.threadRef
    }

    /// Whether the chosen engine looks usable. Codex's sign-in is only known for sure when a request runs.
    var canUseAssistant: Bool {
        switch assistantEngine {
        case .codex: codexStatus?.executable != nil
        case .anthropicAPI: hasAnthropicKey
        }
    }

    func ask(_ question: String) {
        guard let service else { return }
        isAssistantVisible = true
        let context = AssistantContext(accountIDs: accounts.map(\.id), viewing: selectedThread)
        assistant.send(question, context: context, engine: assistantEngine, service: service)
    }

    func refreshCodexStatus() {
        guard let service else { return }
        Task { codexStatus = await service.codexStatus() }
    }

    func refreshKeyState() {
        hasAnthropicKey = service?.hasAPIKey(.anthropic) ?? false
        hasVoyageKey = service?.hasAPIKey(.voyage) ?? false
    }

    func saveAPIKey(_ key: String, for kind: APIKeyKind) async throws {
        guard let service else { return }
        try await service.setAPIKey(key, for: kind)
        refreshKeyState()
        if kind == .anthropic { assistant.reset() }
    }

    private func perform(_ work: @escaping @Sendable () async throws -> Void) {
        Task {
            do {
                try await work()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

struct ComposeRequest: Identifiable {
    let id = UUID()
    var draft: OutgoingMessage
}
