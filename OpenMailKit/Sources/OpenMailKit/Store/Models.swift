import Foundation
import GRDB

public struct EmailAddress: Codable, Hashable, Sendable {
    public var name: String?
    public var email: String

    public init(name: String? = nil, email: String) {
        self.name = name
        self.email = email
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return email
    }

    public var formatted: String {
        guard let name, !name.isEmpty else { return email }
        let needsQuoting = name.contains { ",;<>@\"".contains($0) }
        return needsQuoting ? "\"\(name.replacingOccurrences(of: "\"", with: "\\\""))\" <\(email)>" : "\(name) <\(email)>"
    }
}

public struct Account: Codable, Hashable, Sendable, Identifiable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "accounts"

    /// The Gmail address; stable for the lifetime of the account.
    public var id: String
    public var historyID: String?
    public var backfillPageToken: String?
    public var backfillComplete: Bool
    public var messagesTotal: Int
    public var needsReauth: Bool
    public var lastError: String?
    public var addedAt: Date
    /// Incremented on each full resync; messages not seen by the latest full pass are deleted.
    public var syncGeneration: Int

    public init(id: String, historyID: String?, messagesTotal: Int, addedAt: Date = .now) {
        self.id = id
        self.historyID = historyID
        self.syncGeneration = 1
        self.backfillPageToken = nil
        self.backfillComplete = false
        self.messagesTotal = messagesTotal
        self.needsReauth = false
        self.lastError = nil
        self.addedAt = addedAt
    }
}

public struct MailLabel: Codable, Hashable, Sendable, Identifiable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "labels"

    public var accountID: String
    public var id: String
    public var name: String
    public var isSystem: Bool

    public init(accountID: String, id: String, name: String, isSystem: Bool) {
        self.accountID = accountID
        self.id = id
        self.name = name
        self.isSystem = isSystem
    }
}

public enum SystemLabel {
    public static let inbox = "INBOX"
    public static let sent = "SENT"
    public static let starred = "STARRED"
    public static let unread = "UNREAD"
    public static let trash = "TRASH"
    public static let spam = "SPAM"
    public static let draft = "DRAFT"
}

public struct Message: Codable, Hashable, Sendable, Identifiable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "messages"

    public var accountID: String
    public var id: String
    public var threadID: String
    /// Gmail's ID of the last history record that modified this message.
    public var historyID: String
    public var date: Date
    public var labelIDs: [String]
    public var snippet: String
    public var subject: String
    public var from: EmailAddress?
    public var to: [EmailAddress]
    public var cc: [EmailAddress]
    public var replyTo: [EmailAddress]
    public var messageIDHeader: String?
    public var references: String?
    public var bodyText: String
    public var bodyHTML: String?
    var syncGeneration: Int = 0

    public var isUnread: Bool { labelIDs.contains(SystemLabel.unread) }
    public var isHidden: Bool { labelIDs.contains(SystemLabel.trash) || labelIDs.contains(SystemLabel.spam) }
}

public struct Attachment: Codable, Hashable, Sendable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "attachments"

    public var accountID: String
    public var messageID: String
    /// MIME part ID. Gmail attachment IDs change between fetches, so the part ID is the stable key.
    public var partID: String
    public var gmailAttachmentID: String
    public var filename: String
    public var mimeType: String
    public var size: Int
}

public struct MailThread: Codable, Hashable, Sendable, Identifiable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "threads"

    public var accountID: String
    public var id: String
    public var subject: String
    public var snippet: String
    public var participants: String
    public var lastMessageDate: Date
    public var messageCount: Int
    public var isUnread: Bool
    public var isStarred: Bool
    public var hasAttachments: Bool
    /// True when every message in the thread is in Trash or Spam.
    public var isHidden: Bool

    public var ref: ThreadRef { ThreadRef(accountID: accountID, threadID: id) }
}

struct ThreadLabel: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "threadLabels"

    var accountID: String
    var threadID: String
    var labelID: String
}

public struct ThreadRef: Hashable, Sendable, Codable {
    public var accountID: String
    public var threadID: String

    public init(accountID: String, threadID: String) {
        self.accountID = accountID
        self.threadID = threadID
    }
}

public enum Mailbox: Hashable, Sendable {
    case allInboxes
    case label(accountID: String, labelID: String)
    case allMail(accountID: String)
}

public struct MessageWithAttachments: Hashable, Sendable, Identifiable {
    public var message: Message
    public var attachments: [Attachment]

    public var id: String { message.id }
}
