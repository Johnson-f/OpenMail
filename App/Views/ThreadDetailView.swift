import OpenMailKit
import SwiftUI

struct ThreadDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var expanded: Set<String> = []

    var body: some View {
        Group {
            if let thread = model.selectedThreadSummary, !model.selectedMessages.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(thread.subject.isEmpty ? "(no subject)" : thread.subject)
                            .font(.title2.bold())
                            .textSelection(.enabled)
                            .padding(.bottom, 4)
                        ForEach(model.selectedMessages) { item in
                            MessageCard(
                                item: item,
                                isExpanded: isExpanded(item),
                                toggle: { toggle(item) }
                            )
                        }
                    }
                    .padding(20)
                }
                .id(thread.ref)
            } else {
                ContentUnavailableView("No Message Selected", systemImage: "envelope")
            }
        }
        .onChange(of: model.selectedThread) { expanded = [] }
        .toolbar {
            ToolbarItemGroup {
                Button("Reply", systemImage: "arrowshape.turn.up.left") { model.reply(all: false) }
                Button("Reply All", systemImage: "arrowshape.turn.up.left.2") { model.reply(all: true) }
                Button("Archive", systemImage: "archivebox") { model.archiveSelection() }
                Button("Trash", systemImage: "trash") { model.trashSelection() }
                Button(
                    model.selectedThreadSummary?.isStarred == true ? "Unstar" : "Star",
                    systemImage: model.selectedThreadSummary?.isStarred == true ? "star.fill" : "star"
                ) { model.toggleStarred() }
            }
        }
        .disabled(model.selectedThread == nil)
    }

    private func isExpanded(_ item: MessageWithAttachments) -> Bool {
        item.id == model.selectedMessages.last?.id || item.message.isUnread || expanded.contains(item.id)
    }

    private func toggle(_ item: MessageWithAttachments) {
        if expanded.contains(item.id) { expanded.remove(item.id) } else { expanded.insert(item.id) }
    }
}

private struct MessageCard: View {
    @Environment(AppModel.self) private var model
    let item: MessageWithAttachments
    let isExpanded: Bool
    let toggle: () -> Void

    private var message: Message { item.message }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
                .contentShape(Rectangle())
                .onTapGesture(perform: toggle)
            if isExpanded {
                Divider()
                if let html = message.bodyHTML {
                    HTMLMessageView(html: html)
                } else {
                    Text(message.bodyText)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !item.attachments.isEmpty {
                    attachments
                }
            }
        }
        .padding(14)
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(message.from?.displayName ?? "(unknown sender)")
                    .fontWeight(.semibold)
                if isExpanded {
                    Text(recipientsLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                } else {
                    Text(message.snippet)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Text(message.date.formatted(date: .abbreviated, time: .shortened))
                .font(.caption)
                .foregroundStyle(.secondary)
            if isExpanded {
                Menu {
                    Button("Reply") { model.reply(to: message, all: false) }
                    Button("Reply All") { model.reply(to: message, all: true) }
                } label: {
                    Image(systemName: "arrowshape.turn.up.left")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
    }

    private var recipientsLine: String {
        var parts: [String] = []
        if let from = message.from { parts.append("From: \(from.formatted)") }
        if !message.to.isEmpty { parts.append("To: \(message.to.map(\.formatted).joined(separator: ", "))") }
        if !message.cc.isEmpty { parts.append("Cc: \(message.cc.map(\.formatted).joined(separator: ", "))") }
        return parts.joined(separator: "\n")
    }

    private var attachments: some View {
        ScrollView(.horizontal) {
            HStack {
                ForEach(item.attachments, id: \.partID) { attachment in
                    Button {
                        model.open(attachment)
                    } label: {
                        Label {
                            VStack(alignment: .leading) {
                                Text(attachment.filename).lineLimit(1)
                                Text(attachment.size.formatted(.byteCount(style: .file)))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "doc")
                        }
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .scrollIndicators(.never)
    }
}
