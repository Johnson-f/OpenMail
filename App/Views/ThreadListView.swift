import OpenMailKit
import SwiftUI

struct ThreadListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.selectedThread) {
            ForEach(model.threads, id: \.ref) { thread in
                ThreadRow(thread: thread, showsAccount: model.accounts.count > 1 && model.mailbox == .allInboxes)
                    .tag(thread.ref)
                    .onAppear { model.loadMoreThreadsIfNeeded(after: thread) }
                    .contextMenu {
                        Button("Archive") {
                            model.selectedThread = thread.ref
                            model.archiveSelection()
                        }
                        Button("Move to Trash") {
                            model.selectedThread = thread.ref
                            model.trashSelection()
                        }
                    }
            }
        }
        .overlay {
            if model.threads.isEmpty {
                ContentUnavailableView("No Messages", systemImage: "tray")
            }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItemGroup {
                Button("Get New Mail", systemImage: "arrow.clockwise") { model.refresh() }
                Button("New Message", systemImage: "square.and.pencil") { model.composeNew() }
            }
        }
    }

    private var title: String {
        switch model.mailbox {
        case .allInboxes, nil: "Inbox"
        case .allMail: "All Mail"
        case let .label(accountID, labelID):
            switch labelID {
            case SystemLabel.inbox: "Inbox"
            case SystemLabel.sent: "Sent"
            case SystemLabel.starred: "Starred"
            default: model.labels.first { $0.accountID == accountID && $0.id == labelID }?.name ?? labelID
            }
        }
    }
}

private struct ThreadRow: View {
    let thread: MailThread
    let showsAccount: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(thread.isUnread ? Color.accentColor : .clear)
                .frame(width: 8, height: 8)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(thread.participants.isEmpty ? "(unknown sender)" : thread.participants)
                        .fontWeight(thread.isUnread ? .semibold : .regular)
                        .lineLimit(1)
                    if thread.messageCount > 1 {
                        Text("\(thread.messageCount)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if thread.hasAttachments {
                        Image(systemName: "paperclip").font(.caption).foregroundStyle(.secondary)
                    }
                    if thread.isStarred {
                        Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow)
                    }
                    Text(thread.lastMessageDate.mailListFormat)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(thread.subject.isEmpty ? "(no subject)" : thread.subject)
                    .lineLimit(1)
                Text(thread.snippet)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if showsAccount {
                    Text(thread.accountID)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

extension Date {
    var mailListFormat: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(self) { return "Yesterday" }
        if calendar.isDate(self, equalTo: .now, toGranularity: .year) {
            return formatted(.dateTime.month(.abbreviated).day())
        }
        return formatted(date: .numeric, time: .omitted)
    }
}
