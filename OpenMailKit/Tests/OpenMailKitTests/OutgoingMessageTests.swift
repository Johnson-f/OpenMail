import Foundation
@testable import OpenMailKit
import Testing

struct OutgoingMessageTests {
    let original = Message(
        accountID: "me@example.com",
        id: "m1",
        threadID: "t1",
        historyID: "1",
        date: Date(timeIntervalSince1970: 1_700_000_000),
        labelIDs: ["INBOX"],
        snippet: "",
        subject: "Lunch",
        from: EmailAddress(name: "Alice", email: "alice@example.com"),
        to: [EmailAddress(email: "me@example.com"), EmailAddress(email: "bob@example.com")],
        cc: [EmailAddress(email: "carol@example.com")],
        replyTo: [],
        messageIDHeader: "<m1@example.com>",
        references: "<m0@example.com>",
        bodyText: "Are you free?\n\nA",
        bodyHTML: nil
    )

    @Test func replyAddressesSenderAndThreadsCorrectly() {
        let reply = OutgoingMessage.reply(to: original, accountID: "me@example.com", replyAll: false)
        #expect(reply.to == [EmailAddress(name: "Alice", email: "alice@example.com")])
        #expect(reply.cc.isEmpty)
        #expect(reply.subject == "Re: Lunch")
        #expect(reply.threadID == "t1")
        #expect(reply.inReplyTo == "<m1@example.com>")
        #expect(reply.references == "<m0@example.com> <m1@example.com>")
        #expect(reply.body.contains("> Are you free?\n>\n> A"))
    }

    @Test func replyAllExcludesSelf() {
        let reply = OutgoingMessage.reply(to: original, accountID: "me@example.com", replyAll: true)
        #expect(reply.cc.map(\.email) == ["bob@example.com", "carol@example.com"])
    }

    @Test func replyToOwnMessageGoesToOriginalRecipients() {
        var own = original
        own.from = EmailAddress(email: "me@example.com")
        own.to = [EmailAddress(email: "dave@example.com")]
        own.subject = "RE: Plans"
        let reply = OutgoingMessage.reply(to: own, accountID: "me@example.com", replyAll: false)
        #expect(reply.to.map(\.email) == ["dave@example.com"])
        #expect(reply.subject == "RE: Plans")
    }

    @Test func encodesRFC822WithUTF8Headers() throws {
        let message = OutgoingMessage(
            accountID: "me@example.com",
            to: [EmailAddress(name: "Zoë", email: "zoe@example.com")],
            subject: "Café ☕",
            body: "Line 1\nLine 2",
            inReplyTo: "<m1@example.com>"
        )
        let raw = String(decoding: message.rfc822(), as: UTF8.self)
        #expect(raw.contains("To: =?UTF-8?B?\(Data("Zoë".utf8).base64EncodedString())?= <zoe@example.com>\r\n"))
        #expect(raw.contains("Subject: =?UTF-8?B?\(Data("Café ☕".utf8).base64EncodedString())?=\r\n"))
        #expect(raw.contains("In-Reply-To: <m1@example.com>\r\n"))
        let body = try #require(raw.components(separatedBy: "\r\n\r\n").last)
        let decoded = Data(base64Encoded: body.replacingOccurrences(of: "\r\n", with: ""))
        #expect(decoded.map { String(decoding: $0, as: UTF8.self) } == "Line 1\r\nLine 2")
    }
}
