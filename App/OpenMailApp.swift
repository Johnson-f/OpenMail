import SwiftUI

@main
struct OpenMailApp: App {
    @State private var model = AppModel.launch()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .frame(minWidth: 900, minHeight: 560)
        }
        .commands { MailCommands(model: model) }
    }
}

struct MailCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Message") { model.composeNew() }
                .keyboardShortcut("n")
                .disabled(model.accounts.isEmpty)
        }
        CommandMenu("Mailbox") {
            Button("Get New Mail") { model.refresh() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            Divider()
            Button("Add Google Account…") { model.addAccount() }
        }
        CommandMenu("Message") {
            Button("Reply") { model.reply(all: false) }
                .keyboardShortcut("r")
            Button("Reply All") { model.reply(all: true) }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            Divider()
            Button("Archive") { model.archiveSelection() }
                .keyboardShortcut("a", modifiers: [.command, .control])
            Button("Move to Trash") { model.trashSelection() }
                .keyboardShortcut(.delete)
            Divider()
            Button(model.selectedThreadSummary?.isUnread == true ? "Mark as Read" : "Mark as Unread") { model.toggleUnread() }
                .keyboardShortcut("u", modifiers: [.command, .shift])
            Button(model.selectedThreadSummary?.isStarred == true ? "Unstar" : "Star") { model.toggleStarred() }
                .keyboardShortcut("l", modifiers: [.command, .shift])
        }
    }
}
