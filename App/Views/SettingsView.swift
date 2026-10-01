import OpenMailKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Picker("Run the assistant with", selection: $model.assistantEngine) {
                    Text("My ChatGPT plan, through Codex").tag(AssistantEngine.codex)
                    Text("An Anthropic API key").tag(AssistantEngine.anthropicAPI)
                }
                if model.assistantEngine == .codex {
                    CodexStatusRow()
                }
            } header: {
                Label("Assistant", systemImage: "sparkles")
            }
            if model.assistantEngine == .anthropicAPI {
                APIKeySection(
                    kind: .anthropic,
                    title: "Anthropic",
                    purpose: "Powers the assistant: answering questions about your mail and drafting replies.",
                    consoleURL: URL(string: "https://platform.claude.com/settings/keys")!
                )
            }
            APIKeySection(
                kind: .voyage,
                title: "Voyage AI",
                purpose: "Creates embeddings so search understands meaning, not just keywords. Your messages are sent to Voyage to be indexed.",
                consoleURL: URL(string: "https://dashboard.voyageai.com/api-keys")!
            )
            Section {
                Text("Keys are checked with a small request, then stored in your macOS Keychain.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct CodexStatusRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch model.codexStatus {
            case nil:
                ProgressView().controlSize(.small)
            case let status?:
                if status.executable == nil {
                    Label("Codex isn't installed", systemImage: "xmark.circle.fill").foregroundStyle(.red)
                    Link("Install Codex", destination: URL(string: "https://developers.openai.com/codex/cli")!)
                } else if status.isLoggedIn {
                    Label(status.detail ?? "Signed in", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Label(status.problem ?? "Codex isn't signed in", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            Text("OpenMail runs your installed `codex` command with only its mail tools enabled: no shell, browser or web access. Usage counts against your ChatGPT plan's Codex limits.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button("Check Again") { model.refreshCodexStatus() }
                .controlSize(.small)
        }
        .onAppear { model.refreshCodexStatus() }
    }
}

private struct APIKeySection: View {
    @Environment(AppModel.self) private var model
    let kind: APIKeyKind
    let title: String
    let purpose: String
    let consoleURL: URL

    @State private var key = ""
    @State private var isSaving = false
    @State private var status: String?
    @State private var failed = false

    private var hasKey: Bool {
        kind == .anthropic ? model.hasAnthropicKey : model.hasVoyageKey
    }

    var body: some View {
        Section {
            Text(purpose).font(.callout).foregroundStyle(.secondary)
            SecureField("API key", text: $key, prompt: Text(hasKey ? "Saved in Keychain — paste to replace" : "Paste your API key"))
                .onSubmit(save)
            HStack {
                Link("Get a key", destination: consoleURL).font(.callout)
                Spacer()
                if isSaving { ProgressView().controlSize(.small) }
                if let status {
                    Label(status, systemImage: failed ? "xmark.circle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(failed ? .red : .green)
                        .font(.callout)
                        .lineLimit(2)
                }
                if hasKey {
                    Button("Remove", role: .destructive) { save(removing: true) }
                }
                Button("Save") { save() }
                    .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
            }
        } header: {
            Label(title, systemImage: hasKey ? "key.fill" : "key")
        }
    }

    private func save() {
        save(removing: false)
    }

    private func save(removing: Bool) {
        isSaving = true
        status = nil
        Task {
            defer { isSaving = false }
            do {
                try await model.saveAPIKey(removing ? "" : key, for: kind)
                key = ""
                failed = false
                status = removing ? "Removed" : "Saved"
            } catch {
                failed = true
                status = error.localizedDescription
            }
        }
    }
}
