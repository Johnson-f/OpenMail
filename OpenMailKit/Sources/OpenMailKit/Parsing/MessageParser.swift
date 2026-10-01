import Foundation

struct ParsedMessage: Sendable {
    var message: Message
    var attachments: [Attachment]
}

enum MessageParser {
    static func parse(_ gmail: GmailMessage, accountID: String) -> ParsedMessage {
        let payload = gmail.payload
        let headers = Headers(payload?.headers ?? [])
        var bodies = Bodies()
        var attachments: [Attachment] = []
        if let payload {
            collect(payload, accountID: accountID, messageID: gmail.id, bodies: &bodies, attachments: &attachments)
        }

        let html = bodies.html
        let text = bodies.plain ?? html.map(HTMLText.plainText(fromHTML:)) ?? ""
        let message = Message(
            accountID: accountID,
            id: gmail.id,
            threadID: gmail.threadId,
            historyID: gmail.historyId,
            date: Date(timeIntervalSince1970: (Double(gmail.internalDate) ?? 0) / 1000),
            labelIDs: gmail.labelIds ?? [],
            snippet: HTMLText.decodeEntities(gmail.snippet ?? ""),
            subject: headers["Subject"] ?? "",
            from: AddressParser.parseList(headers["From"]).first,
            to: AddressParser.parseList(headers["To"]),
            cc: AddressParser.parseList(headers["Cc"]),
            replyTo: AddressParser.parseList(headers["Reply-To"]),
            messageIDHeader: headers["Message-ID"],
            references: headers["References"],
            bodyText: text,
            bodyHTML: html
        )
        return ParsedMessage(message: message, attachments: attachments)
    }

    private struct Bodies {
        var plain: String?
        var html: String?
    }

    private static func collect(
        _ part: GmailPart,
        accountID: String,
        messageID: String,
        bodies: inout Bodies,
        attachments: inout [Attachment]
    ) {
        let mimeType = part.mimeType?.lowercased() ?? ""
        if let filename = part.filename, !filename.isEmpty, let attachmentID = part.body?.attachmentId {
            attachments.append(Attachment(
                accountID: accountID,
                messageID: messageID,
                partID: part.partId ?? attachmentID,
                gmailAttachmentID: attachmentID,
                filename: filename,
                mimeType: mimeType,
                size: part.body?.size ?? 0
            ))
            return
        }
        if let children = part.parts, !children.isEmpty {
            for child in children {
                collect(child, accountID: accountID, messageID: messageID, bodies: &bodies, attachments: &attachments)
            }
            return
        }
        guard let data = part.body?.data.flatMap(Data.init(base64URLEncoded:)) else { return }
        let charset = Headers(part.headers ?? [])["Content-Type"].flatMap(Self.charset)
        if mimeType == "text/plain", bodies.plain == nil {
            bodies.plain = decode(data, charset: charset)
        } else if mimeType == "text/html", bodies.html == nil {
            bodies.html = decode(data, charset: charset)
        }
    }

    /// Prefers strict UTF-8 because mislabelled charsets are common; falls back to the declared charset.
    static func decode(_ data: Data, charset: String?) -> String {
        if let utf8 = String(data: data, encoding: .utf8) { return utf8 }
        if let charset {
            let cfEncoding = CFStringConvertIANACharSetNameToEncoding(charset as CFString)
            if cfEncoding != kCFStringEncodingInvalidId {
                let encoding = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cfEncoding))
                if let decoded = String(data: data, encoding: encoding) { return decoded }
            }
        }
        return String(data: data, encoding: .isoLatin1) ?? String(decoding: data, as: UTF8.self)
    }

    static func charset(fromContentType contentType: String) -> String? {
        guard let match = contentType.firstMatch(of: /(?i)charset\s*=\s*"?([^";\s]+)"?/) else { return nil }
        return String(match.output.1)
    }
}

struct Headers {
    private let values: [String: String]

    init(_ headers: [GmailHeader]) {
        values = Dictionary(headers.map { ($0.name.lowercased(), $0.value) }, uniquingKeysWith: { first, _ in first })
    }

    subscript(name: String) -> String? {
        values[name.lowercased()]
    }
}
