import OpenMailKit
import SwiftUI

struct AssistantPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openSettings) private var openSettings
    @State private var input = ""
    @FocusState private var isInputFocused: Bool

    private var assistant: AssistantModel { model.assistant }

    var body: some View {
        VStack(spacing: 0) {
            if !model.canUseAssistant {
                ContentUnavailableView {
                    Label("Connect Claude", systemImage: "sparkles")
                } description: {
                    Text(model.assistantEngine == .codex
                         ? "Install Codex and sign in with ChatGPT, or switch to an API key in Settings."
                         : "Add an Anthropic API key in Settings to ask questions about your mail.")
                } actions: {
                    Button("Open Settings…") { openSettings() }
                }
            } else if assistant.turns.isEmpty {
                ContentUnavailableView {
                    Label("Ask about your mail", systemImage: "sparkles")
                } description: {
                    Text(model.selectedThread == nil
                         ? "Try “What do I need to reply to this week?”"
                         : "Try “Summarize this conversation” or “Draft a reply”.")
                }
            } else {
                transcript
            }
            Divider()
            inputBar
        }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == CitationText.scheme, let key = url.host() else { return .systemAction }
            model.openCitation(key)
            return .handled
        })
        .onAppear { isInputFocused = true }
        .toolbar {
            ToolbarItem {
                Button("New Conversation", systemImage: "square.and.pencil") { assistant.reset() }
                    .disabled(assistant.turns.isEmpty)
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(assistant.turns) { turn in
                        TurnView(turn: turn, isRunning: assistant.isRunning && turn.id == assistant.turns.last?.id)
                            .id(turn.id)
                    }
                }
                .padding(14)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: assistant.turns.last?.segments.count) {
                if let id = assistant.turns.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask about your mail…", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($isInputFocused)
                .onSubmit(submit)
                .disabled(!model.canUseAssistant)
            if assistant.isRunning {
                Button("Stop", systemImage: "stop.circle.fill") { assistant.stop() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
            } else {
                Button("Send", systemImage: "arrow.up.circle.fill") { submit() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || !model.canUseAssistant)
            }
        }
        .font(.body)
        .imageScale(.large)
        .padding(12)
    }

    private func submit() {
        guard !assistant.isRunning else { return }
        model.ask(input)
        input = ""
    }
}

private struct TurnView: View {
    @Environment(AppModel.self) private var model
    let turn: AssistantModel.Turn
    let isRunning: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(turn.question)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .textSelection(.enabled)
            ForEach(turn.segments) { segment in
                switch segment {
                case let .text(_, text):
                    Text(CitationText.attributed(text))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case let .activity(_, description):
                    Label(description, systemImage: "magnifyingglass")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case let .draft(proposal):
                    DraftCard(draft: proposal.draft)
                }
            }
            if isRunning {
                ProgressView().controlSize(.small)
            }
            if let error = turn.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
        }
    }
}

private struct DraftCard: View {
    @Environment(AppModel.self) private var model
    let draft: OutgoingMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Draft", systemImage: "envelope.open")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            Text("To: \(draft.to.map(\.formatted).joined(separator: ", "))").font(.caption)
            Text(draft.subject).font(.callout.bold())
            Text(draft.body.components(separatedBy: "\n\nOn ").first ?? draft.body)
                .font(.callout)
                .lineLimit(8)
            Button("Open in Composer") { model.compose = ComposeRequest(draft: draft) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
    }
}

/// Renders Claude's Markdown and turns citation keys like [M3] into links that open the cited message.
enum CitationText {
    static let scheme = "openmail-cite"

    static func attributed(_ text: String) -> AttributedString {
        let linked = text.replacing(/\[(M\d+(?:\s*,\s*M\d+)*)\]/) { match in
            match.output.1
                .split(separator: ",")
                .map { key in
                    let key = key.trimmingCharacters(in: .whitespaces)
                    return "[\(key)](\(scheme)://\(key))"
                }
                .joined(separator: " ")
        }
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var attributed = (try? AttributedString(markdown: linked, options: options)) ?? AttributedString(text)
        for run in attributed.runs where run.link?.scheme == scheme {
            attributed[run.range].font = .caption.bold()
            attributed[run.range].baselineOffset = 3
        }
        return attributed
    }
}
