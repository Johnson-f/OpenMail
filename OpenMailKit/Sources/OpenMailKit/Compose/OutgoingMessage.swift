import Foundation

public struct OutgoingMessage: Hashable, Sendable {
    public var accountID: String
    public var to: [EmailAddress]
    public var cc: [EmailAddress]
    public var subject: String
    public var body: String
    public var threadID: String?
    public var inReplyTo: String?
    public var references: String?

    public init(
        accountID: String,
        to: [EmailAddress] = [],
        cc: [EmailAddress] = [],
        subject: String = "",
        body: String = "",
        threadID: String? = nil,
        inReplyTo: String? = nil,
        references: String? = nil
    ) {
        self.accountID = accountID
        self.to = to
        self.cc = cc
        self.subject = subject
        self.body = body
        self.threadID = threadID
        self.inReplyTo = inReplyTo
        self.references = references
    }

    public static func parseAddresses(_ text: String) -> [EmailAddress] {
        AddressParser.parseList(text)
    }

    public static func reply(to message: Message, accountID: String, replyAll: Bool) -> OutgoingMessage {
        let isOwnMessage = message.from?.email.caseInsensitiveCompare(accountID) == .orderedSame
        var to: [EmailAddress]
        if isOwnMessage {
            to = message.to
        } else if !message.replyTo.isEmpty {
            to = message.replyTo
        } else {
            to = message.from.map { [$0] } ?? []
        }
        var cc: [EmailAddress] = []
        if replyAll {
            let extra = isOwnMessage ? message.cc : message.to + message.cc
            cc = extra.filter { candidate in
                candidate.email.caseInsensitiveCompare(accountID) != .orderedSame
                    && !to.contains { $0.email.caseInsensitiveCompare(candidate.email) == .orderedSame }
            }
        }
        to = deduplicated(to)

        let subject = message.subject.range(of: #"^\s*re:"#, options: [.regularExpression, .caseInsensitive]) == nil
            ? "Re: \(message.subject)"
            : message.subject
        let references = [message.references, message.messageIDHeader]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        return OutgoingMessage(
            accountID: accountID,
            to: to,
            cc: deduplicated(cc),
            subject: subject,
            body: "\n\n" + quoted(message),
            threadID: message.threadID,
            inReplyTo: message.messageIDHeader,
            references: references.isEmpty ? nil : references
        )
    }

    private static func quoted(_ message: Message) -> String {
        let date = message.date.formatted(date: .abbreviated, time: .shortened)
        let author = message.from?.formatted ?? "someone"
        let body = message.bodyText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? ">" : "> \($0)" }
            .joined(separator: "\n")
        return "On \(date), \(author) wrote:\n\(body)"
    }

    private static func deduplicated(_ addresses: [EmailAddress]) -> [EmailAddress] {
        var seen = Set<String>()
        return addresses.filter { seen.insert($0.email.lowercased()).inserted }
    }

    /// Encodes the message as RFC 5322 for Gmail's `messages.send`.
    func rfc822(date: Date = .now) -> Data {
        var headers = [
            "From: \(accountID)",
            "To: \(Self.addressHeader(to))",
        ]
        if !cc.isEmpty { headers.append("Cc: \(Self.addressHeader(cc))") }
        headers.append("Subject: \(Self.encodeHeaderValue(subject))")
        headers.append("Date: \(Self.rfc2822Date(date))")
        if let inReplyTo { headers.append("In-Reply-To: \(inReplyTo)") }
        if let references { headers.append("References: \(references)") }
        headers += [
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=\"UTF-8\"",
            "Content-Transfer-Encoding: base64",
        ]
        let normalizedBody = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\r\n")
        let encodedBody = Data(normalizedBody.utf8).base64EncodedString(options: [.lineLength76Characters, .endLineWithCarriageReturn, .endLineWithLineFeed])
        return Data((headers.joined(separator: "\r\n") + "\r\n\r\n" + encodedBody + "\r\n").utf8)
    }

    static func addressHeader(_ addresses: [EmailAddress]) -> String {
        addresses.map { address in
            guard let name = address.name, name.unicodeScalars.contains(where: { !$0.isASCII }) else { return address.formatted }
            return "\(encodeHeaderValue(name)) <\(address.email)>"
        }.joined(separator: ", ")
    }

    static func encodeHeaderValue(_ value: String) -> String {
        guard value.unicodeScalars.contains(where: { !$0.isASCII }) else { return value }
        return "=?UTF-8?B?\(Data(value.utf8).base64EncodedString())?="
    }

    private static func rfc2822Date(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
        return formatter.string(from: date)
    }
}
