import Foundation

public struct GmailProfile: Decodable, Sendable {
    public var emailAddress: String
    public var messagesTotal: Int?
    public var historyId: String
}

public struct GmailMessageRef: Codable, Hashable, Sendable {
    public var id: String
    public var threadId: String
}

public struct GmailMessageList: Decodable, Sendable {
    public var messages: [GmailMessageRef]?
    public var nextPageToken: String?
}

public struct GmailHeader: Codable, Hashable, Sendable {
    public var name: String
    public var value: String
}

public struct GmailBody: Codable, Hashable, Sendable {
    public var attachmentId: String?
    public var size: Int?
    public var data: String?
}

public struct GmailPart: Codable, Hashable, Sendable {
    public var partId: String?
    public var mimeType: String?
    public var filename: String?
    public var headers: [GmailHeader]?
    public var body: GmailBody?
    public var parts: [GmailPart]?
}

public struct GmailMessage: Codable, Hashable, Sendable {
    public var id: String
    public var threadId: String
    public var labelIds: [String]?
    public var snippet: String?
    public var historyId: String
    public var internalDate: String
    public var payload: GmailPart?
}

public enum GmailMessageFormat: String, Sendable {
    case full
    case minimal
}

public struct GmailHistoryPage: Decodable, Sendable {
    public var history: [GmailHistoryRecord]?
    public var nextPageToken: String?
    public var historyId: String
}

public struct GmailHistoryRecord: Decodable, Sendable {
    public struct MessageEvent: Decodable, Sendable {
        public var message: GmailMessageRef
    }

    public var id: String
    public var messagesAdded: [MessageEvent]?
    public var messagesDeleted: [MessageEvent]?
    public var labelsAdded: [MessageEvent]?
    public var labelsRemoved: [MessageEvent]?
}

public struct GmailLabel: Decodable, Sendable {
    public var id: String
    public var name: String
    public var type: String?
}
