import OpenMailKit
import SwiftUI

struct ComposeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var accountID: String
    @State private var to: String
    @State private var cc: String
    @State private var subject: String
    @State private var bodyText: String
    @State private var isSending = false
    @State private var sendError: String?
    private let original: OutgoingMessage

    init(draft: OutgoingMessage) {
        original = draft
        _accountID = State(initialValue: draft.accountID)
        _to = State(initialValue: draft.to.map(\.formatted).joined(separator: ", "))
        _cc = State(initialValue: draft.cc.map(\.formatted).joined(separator: ", "))
        _subject = State(initialValue: draft.subject)
        _bodyText = State(initialValue: draft.body)
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                if model.accounts.count > 1, original.threadID == nil {
                    Picker("From", selection: $accountID) {
                        ForEach(model.accounts) { Text($0.id).tag($0.id) }
                    }
                } else {
                    LabeledContent("From", value: accountID)
                }
                TextField("To", text: $to)
                TextField("Cc", text: $cc)
                TextField("Subject", text: $subject)
            }
            .formStyle(.grouped)
            .scrollDisabled(true)
            .fixedSize(horizontal: false, vertical: true)

            TextEditor(text: $bodyText)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 16)
                .frame(minHeight: 260)

            if let sendError {
                Text(sendError)
                    .foregroundStyle(.red)
                    .font(.callout)
                    .padding(.horizontal)
            }

            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                if isSending { ProgressView().controlSize(.small) }
                Button("Send") { send() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .disabled(isSending || recipients.isEmpty)
            }
            .padding()
        }
        .frame(minWidth: 560, minHeight: 520)
    }

    private var recipients: [EmailAddress] {
        OutgoingMessage.parseAddresses(to)
    }

    private func send() {
        var message = original
        message.accountID = accountID
        message.to = recipients
        message.cc = OutgoingMessage.parseAddresses(cc)
        message.subject = subject
        message.body = bodyText
        isSending = true
        sendError = nil
        Task {
            defer { isSending = false }
            do {
                try await model.send(message)
                dismiss()
            } catch {
                sendError = "Couldn't send: \(error.localizedDescription)"
            }
        }
    }
}
