import OpenMailKit
import SwiftUI

/// ⌘K: type to search mail instantly, or press Return on the first row to ask the assistant.
struct CommandPalette: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var highlighted = 0
    @State private var searchError: String?
    @FocusState private var isFocused: Bool

    private var rowCount: Int { (canAsk ? 1 : 0) + hits.count }
    private var canAsk: Bool { model.canUseAssistant && !trimmedQuery.isEmpty }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search mail or ask a question", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($isFocused)
                    .onSubmit(activateHighlighted)
            }
            .padding(14)
            Divider()
            results
        }
        .frame(width: 620, height: 440)
        .onAppear { isFocused = true }
        .onKeyPress(.downArrow) {
            highlighted = min(highlighted + 1, max(rowCount - 1, 0))
            return .handled
        }
        .onKeyPress(.upArrow) {
            highlighted = max(highlighted - 1, 0)
            return .handled
        }
        .task(id: trimmedQuery) {
            highlighted = 0
            guard !trimmedQuery.isEmpty else {
                hits = []
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            do {
                hits = try await model.search(trimmedQuery)
                searchError = nil
            } catch {
                searchError = error.localizedDescription
            }
        }
    }

    private var results: some View {
        ScrollViewReader { proxy in
            List {
                if canAsk {
                    Label("Ask the assistant: “\(trimmedQuery)”", systemImage: "sparkles")
                        .padding(.vertical, 4)
                        .listRowBackground(rowBackground(0))
                        .id(0)
                        .onTapGesture { ask() }
                }
                ForEach(Array(hits.enumerated()), id: \.element.id) { offset, hit in
                    let index = offset + (canAsk ? 1 : 0)
                    HitRow(hit: hit)
                        .listRowBackground(rowBackground(index))
                        .id(index)
                        .onTapGesture { open(hit) }
                }
                if let searchError {
                    Text(searchError).foregroundStyle(.secondary)
                }
            }
            .listStyle(.plain)
            .onChange(of: highlighted) { proxy.scrollTo(highlighted) }
            .overlay {
                if trimmedQuery.isEmpty {
                    Text(model.hasVoyageKey ? "Search by keyword or meaning" : "Search by keyword. Add a Voyage key in Settings to also search by meaning.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding()
                }
            }
        }
    }

    private func rowBackground(_ index: Int) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(index == highlighted ? Color.accentColor.opacity(0.2) : .clear)
    }

    private func activateHighlighted() {
        if canAsk && highlighted == 0 {
            ask()
        } else if let hit = hits[safe: highlighted - (canAsk ? 1 : 0)] {
            open(hit)
        }
    }

    private func ask() {
        model.ask(trimmedQuery)
        dismiss()
    }

    private func open(_ hit: SearchHit) {
        model.open(hit.threadRef)
        dismiss()
    }
}

private struct HitRow: View {
    let hit: SearchHit

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(hit.message.from?.displayName ?? "(unknown sender)").fontWeight(.semibold).lineLimit(1)
                Spacer()
                Text(hit.message.date.mailListFormat).font(.caption).foregroundStyle(.secondary)
            }
            Text(hit.message.subject.isEmpty ? "(no subject)" : hit.message.subject).lineLimit(1)
            Text(hit.excerpt).font(.callout).foregroundStyle(.secondary).lineLimit(2)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
