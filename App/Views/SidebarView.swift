import OpenMailKit
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @State private var accountPendingRemoval: String?

    var body: some View {
        @Bindable var model = model
        List(selection: $model.mailbox) {
            if model.accounts.count > 1 {
                Label("All Inboxes", systemImage: "tray.2").tag(Mailbox.allInboxes)
            }
            ForEach(model.accounts) { account in
                Section {
                    AccountStatusView(account: account, syncedCount: model.messageCounts[account.id] ?? 0)
                    if model.accounts.count == 1 {
                        Label("Inbox", systemImage: "tray").tag(Mailbox.allInboxes)
                    } else {
                        Label("Inbox", systemImage: "tray").tag(Mailbox.label(accountID: account.id, labelID: SystemLabel.inbox))
                    }
                    Label("Starred", systemImage: "star").tag(Mailbox.label(accountID: account.id, labelID: SystemLabel.starred))
                    Label("Sent", systemImage: "paperplane").tag(Mailbox.label(accountID: account.id, labelID: SystemLabel.sent))
                    Label("All Mail", systemImage: "archivebox").tag(Mailbox.allMail(accountID: account.id))
                    ForEach(userLabels(for: account.id)) { label in
                        Label(label.name, systemImage: "tag").tag(Mailbox.label(accountID: account.id, labelID: label.id))
                    }
                } header: {
                    Text(account.id)
                        .contextMenu {
                            Button("Remove Account…", role: .destructive) { accountPendingRemoval = account.id }
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
                SearchIndexStatusView()
                Button {
                    model.addAccount()
                } label: {
                    Label(model.isAddingAccount ? "Waiting for browser…" : "Add Account", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .disabled(model.isAddingAccount)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
        }
        .confirmationDialog(
            "Remove \(accountPendingRemoval ?? "")?",
            isPresented: Binding(get: { accountPendingRemoval != nil }, set: { if !$0 { accountPendingRemoval = nil } }),
            presenting: accountPendingRemoval
        ) { accountID in
            Button("Remove Account", role: .destructive) { model.removeAccount(accountID) }
        } message: { _ in
            Text("Its downloaded mail will be deleted from this Mac. Nothing is deleted from Gmail.")
        }
    }

    private func userLabels(for accountID: String) -> [MailLabel] {
        model.labels.filter { $0.accountID == accountID && !$0.isSystem }
    }
}

private struct SearchIndexStatusView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        if !model.hasVoyageKey {
            Button("Enable semantic search…") { openSettings() }
                .buttonStyle(.link)
                .font(.caption)
        } else if let status = model.indexStatus {
            if let error = status.lastError {
                Label("Indexing paused", systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help(error)
            } else if status.pendingChunks > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Indexing for search… \(status.embeddedChunks.formatted()) of \(status.totalChunks.formatted())")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ProgressView(value: Double(status.embeddedChunks + status.failedChunks), total: Double(max(status.totalChunks, 1)))
                        .controlSize(.small)
                }
            }
        }
    }
}

private struct AccountStatusView: View {
    @Environment(AppModel.self) private var model
    let account: Account
    let syncedCount: Int

    var body: some View {
        if account.needsReauth {
            Button {
                model.addAccount()
            } label: {
                Label("Sign in again", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            }
            .buttonStyle(.borderless)
            .selectionDisabled()
        } else if !account.backfillComplete {
            VStack(alignment: .leading, spacing: 4) {
                Text("Downloading mail… \(syncedCount.formatted()) of \(max(account.messagesTotal, syncedCount).formatted())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ProgressView(value: Double(syncedCount), total: Double(max(account.messagesTotal, syncedCount, 1)))
                    .controlSize(.small)
            }
            .selectionDisabled()
        } else if let error = account.lastError {
            Label("Sync problem", systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .help(error)
                .selectionDisabled()
        }
    }
}
