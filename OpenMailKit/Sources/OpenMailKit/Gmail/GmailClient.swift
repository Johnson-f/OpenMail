import Foundation

public protocol GmailAPI: Sendable {
    func profile() async throws -> GmailProfile
    func listMessages(pageToken: String?) async throws -> GmailMessageList
    func message(id: String, format: GmailMessageFormat) async throws -> GmailMessage
    func history(startHistoryID: String, pageToken: String?) async throws -> GmailHistoryPage
    func labels() async throws -> [GmailLabel]
    func modifyThread(id: String, add: [String], remove: [String]) async throws
    func trashThread(id: String) async throws
    func send(raw: Data, threadID: String?) async throws -> GmailMessageRef
    func attachment(messageID: String, attachmentID: String) async throws -> Data
}

public enum GmailError: Error, Equatable {
    case notFound
    /// The stored history ID is too old; a full resync is required.
    case historyExpired
    case http(status: Int, body: String)
}

public final class GmailClient: GmailAPI {
    private static let baseURL = URL(string: "https://gmail.googleapis.com/gmail/v1/users/me/")!
    private static let maxAttempts = 5

    private let transport: any HTTPTransport
    private let tokens: any AccessTokenProvider

    public init(transport: any HTTPTransport, tokens: any AccessTokenProvider) {
        self.transport = transport
        self.tokens = tokens
    }

    public func profile() async throws -> GmailProfile {
        try await get("profile")
    }

    public func listMessages(pageToken: String?) async throws -> GmailMessageList {
        var query = [URLQueryItem(name: "maxResults", value: "500")]
        if let pageToken { query.append(URLQueryItem(name: "pageToken", value: pageToken)) }
        return try await get("messages", query: query)
    }

    public func message(id: String, format: GmailMessageFormat) async throws -> GmailMessage {
        try await get("messages/\(id)", query: [URLQueryItem(name: "format", value: format.rawValue)])
    }

    public func history(startHistoryID: String, pageToken: String?) async throws -> GmailHistoryPage {
        var query = [
            URLQueryItem(name: "startHistoryId", value: startHistoryID),
            URLQueryItem(name: "maxResults", value: "500"),
        ]
        if let pageToken { query.append(URLQueryItem(name: "pageToken", value: pageToken)) }
        do {
            return try await get("history", query: query)
        } catch GmailError.notFound {
            throw GmailError.historyExpired
        }
    }

    public func labels() async throws -> [GmailLabel] {
        struct Response: Decodable { var labels: [GmailLabel]? }
        let response: Response = try await get("labels")
        return response.labels ?? []
    }

    public func modifyThread(id: String, add: [String], remove: [String]) async throws {
        struct Body: Encodable { var addLabelIds: [String]; var removeLabelIds: [String] }
        _ = try await perform("threads/\(id)/modify", method: "POST", body: Body(addLabelIds: add, removeLabelIds: remove))
    }

    public func trashThread(id: String) async throws {
        _ = try await perform("threads/\(id)/trash", method: "POST", body: Optional<String>.none)
    }

    public func send(raw: Data, threadID: String?) async throws -> GmailMessageRef {
        struct Body: Encodable { var raw: String; var threadId: String? }
        let data = try await perform("messages/send", method: "POST", body: Body(raw: raw.base64URLEncodedString(), threadId: threadID))
        return try JSONDecoder().decode(GmailMessageRef.self, from: data)
    }

    public func attachment(messageID: String, attachmentID: String) async throws -> Data {
        struct Response: Decodable { var data: String }
        let response: Response = try await get("messages/\(messageID)/attachments/\(attachmentID)")
        guard let data = Data(base64URLEncoded: response.data) else { throw GmailError.http(status: 200, body: "Invalid attachment encoding") }
        return data
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let data = try await perform(path, method: "GET", query: query, body: Optional<String>.none)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func perform(
        _ path: String,
        method: String,
        query: [URLQueryItem] = [],
        body: (some Encodable)?
    ) async throws -> Data {
        var components = URLComponents(url: Self.baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        var forceRefresh = false
        for attempt in 1...Self.maxAttempts {
            let token = try await tokens.accessToken(forceRefresh: forceRefresh)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 200..<300:
                return data
            case 401 where !forceRefresh:
                forceRefresh = true
                continue
            case 404:
                throw GmailError.notFound
            case _ where Self.isRetryable(response.statusCode, data) && attempt < Self.maxAttempts:
                try await Task.sleep(for: .seconds(pow(2, Double(attempt - 1))) + .milliseconds(Int.random(in: 0..<500)))
                continue
            default:
                break
            }
            throw GmailError.http(status: response.statusCode, body: String(decoding: data, as: UTF8.self))
        }
        throw GmailError.http(status: 0, body: "Request failed after \(Self.maxAttempts) attempts")
    }

    private static func isRetryable(_ status: Int, _ data: Data) -> Bool {
        switch status {
        case 429, 500..<600: return true
        case 403:
            let body = String(decoding: data, as: UTF8.self)
            return body.contains("rateLimitExceeded") || body.contains("userRateLimitExceeded")
        default: return false
        }
    }
}

extension Data {
    init?(base64URLEncoded string: String) {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 = base64.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
