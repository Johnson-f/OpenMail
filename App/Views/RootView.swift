import OpenMailKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            switch model.launchState {
            case let .failed(message):
                ContentUnavailableView("OpenMail can't start", systemImage: "exclamationmark.triangle", description: Text(message))
            case .ready where !model.hasLoadedAccounts:
                Color.clear
            case .ready where model.accounts.isEmpty:
                WelcomeView()
            case .ready:
                MailView()
            }
        }
        .sheet(item: $model.compose) { request in
            ComposeView(draft: request.draft)
        }
        .alert("Something went wrong", isPresented: isShowingError, presenting: model.errorMessage) { _ in
            Button("OK") { model.errorMessage = nil }
        } message: { message in
            Text(message)
        }
    }

    private var isShowingError: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )
    }
}

struct MailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 230)
        } content: {
            ThreadListView()
                .navigationSplitViewColumnWidth(min: 300, ideal: 360)
        } detail: {
            ThreadDetailView()
                .inspector(isPresented: $model.isAssistantVisible) {
                    AssistantPanel()
                        .inspectorColumnWidth(min: 300, ideal: 380, max: 560)
                }
        }
        .sheet(isPresented: $model.isPaletteVisible) {
            CommandPalette()
        }
    }
}

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "envelope.badge.shield.half.filled")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Welcome to OpenMail")
                .font(.largeTitle.bold())
            Text("Connect a Google account to download your mail to this Mac.")
                .foregroundStyle(.secondary)
            if model.isAddingAccount {
                ProgressView("Waiting for Google sign-in in your browser…")
                Button("Cancel") { model.cancelAddAccount() }
            } else {
                Button("Connect Google Account") { model.addAccount() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
