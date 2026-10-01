import Foundation
@testable import OpenMailKit
import Testing

struct AddressParserTests {
    @Test func parsesNamesQuotesAndBareAddresses() {
        let list = AddressParser.parseList(#""Doe, Jane" <jane@x.com>, bob@y.com, Carol <carol@z.com>"#)
        #expect(list == [
            EmailAddress(name: "Doe, Jane", email: "jane@x.com"),
            EmailAddress(email: "bob@y.com"),
            EmailAddress(name: "Carol", email: "carol@z.com"),
        ])
    }

    @Test func skipsGroupSyntaxWithoutAddresses() {
        #expect(AddressParser.parseList("undisclosed-recipients:;").isEmpty)
    }
}

struct HTMLTextTests {
    @Test func stripsMarkupAndKeepsStructure() {
        let html = "<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>there</b></p><ul><li>One</li><li>Two</li></ul>Fish &amp; chips &#8212; &#x263A;</body></html>"
        #expect(HTMLText.plainText(fromHTML: html) == "Hello there\n• One\n• Two\nFish & chips — ☺")
    }
}

struct MessageParserTests {
    @Test func parsesMultipartWithAttachment() {
        let gmail = GmailMessage(
            id: "m1",
            threadId: "t1",
            labelIds: ["INBOX"],
            snippet: "It&#39;s here",
            historyId: "42",
            internalDate: "1700000000000",
            payload: GmailPart(
                partId: "",
                mimeType: "multipart/mixed",
                filename: "",
                headers: [
                    GmailHeader(name: "from", value: "Alice <alice@example.com>"),
                    GmailHeader(name: "To", value: "me@example.com, bob@example.com"),
                    GmailHeader(name: "Subject", value: "Report"),
                ],
                parts: [
                    GmailPart(partId: "0", mimeType: "multipart/alternative", filename: "", parts: [
                        GmailPart(partId: "0.0", mimeType: "text/plain", filename: "", body: GmailBody(data: Data("Plain body".utf8).base64URLEncodedString())),
                        GmailPart(partId: "0.1", mimeType: "text/html", filename: "", body: GmailBody(data: Data("<p>HTML body</p>".utf8).base64URLEncodedString())),
                    ]),
                    GmailPart(partId: "1", mimeType: "application/pdf", filename: "report.pdf", body: GmailBody(attachmentId: "att-xyz", size: 1234)),
                ]
            )
        )
        let parsed = MessageParser.parse(gmail, accountID: "me@example.com")
        #expect(parsed.message.subject == "Report")
        #expect(parsed.message.from == EmailAddress(name: "Alice", email: "alice@example.com"))
        #expect(parsed.message.to.count == 2)
        #expect(parsed.message.bodyText == "Plain body")
        #expect(parsed.message.bodyHTML == "<p>HTML body</p>")
        #expect(parsed.message.snippet == "It's here")
        #expect(parsed.message.date == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(parsed.attachments.map(\.filename) == ["report.pdf"])
        #expect(parsed.attachments.first?.partID == "1")
    }

    @Test func derivesTextFromHTMLWhenNoPlainPart() {
        var gmail = Fixtures.message(id: "m1", thread: "t1")
        gmail.payload?.mimeType = "text/html"
        gmail.payload?.body = GmailBody(data: Data("<div>Line one</div><div>Line two</div>".utf8).base64URLEncodedString())
        let parsed = MessageParser.parse(gmail, accountID: "me@example.com")
        #expect(parsed.message.bodyText == "Line one\nLine two")
    }

    @Test func decodesDeclaredCharsetWhenNotUTF8() {
        let latin1 = "café".data(using: .isoLatin1)!
        #expect(MessageParser.decode(latin1, charset: "iso-8859-1") == "café")
        #expect(MessageParser.charset(fromContentType: #"text/plain; charset="Windows-1252""#) == "Windows-1252")
    }
}
