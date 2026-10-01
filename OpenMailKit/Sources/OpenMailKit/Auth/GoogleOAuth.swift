import CryptoKit
import Foundation

public struct GoogleOAuthConfig: Sendable {
    public var clientID: String
    public var clientSecret: String

    public init(clientID: String, clientSecret: String) {
        self.clientID = clientID
        self.clientSecret = clientSecret
    }
}

public enum AuthError: Error, Equatable {
    case reauthenticationRequired
    case missingRefreshToken
    case stateMismatch
    case denied(String)
    case tokenEndpoint(status: Int, body: String)
}

struct TokenResponse: Decodable {
    var access_token: String
    var expires_in: Int
    var refresh_token: String?
}

struct PKCE {
    let verifier: String
    let challenge: String

    init(verifier: String = PKCE.randomVerifier()) {
        self.verifier = verifier
        challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }

    static func randomVerifier() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64URLEncodedString()
    }
}

public struct GoogleOAuth: Sendable {
    static let scopes = ["https://www.googleapis.com/auth/gmail.modify"]
    private static let authorizationURL = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    private static let tokenURL = URL(string: "https://oauth2.googleapis.com/token")!

    let config: GoogleOAuthConfig
    let transport: any HTTPTransport

    public init(config: GoogleOAuthConfig, transport: any HTTPTransport) {
        self.config = config
        self.transport = transport
    }

    /// Runs the browser sign-in flow and returns a fresh access token plus refresh token.
    func signIn(openURL: @Sendable (URL) async -> Void) async throws -> (refreshToken: String, accessToken: AccessToken) {
        let server = try await LoopbackServer.start()
        defer { server.stop() }
        let pkce = PKCE()
        let state = PKCE.randomVerifier()
        let redirectURI = "http://127.0.0.1:\(server.port)"

        await openURL(authorizationURL(redirectURI: redirectURI, pkce: pkce, state: state))
        let callback = try await server.waitForCallback()

        if let error = callback["error"] { throw AuthError.denied(error) }
        guard callback["state"] == state else { throw AuthError.stateMismatch }
        guard let code = callback["code"] else { throw AuthError.denied("missing_code") }

        let response = try await requestToken([
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": pkce.verifier,
            "redirect_uri": redirectURI,
        ])
        guard let refreshToken = response.refresh_token else { throw AuthError.missingRefreshToken }
        return (refreshToken, AccessToken(response))
    }

    func refresh(_ refreshToken: String) async throws -> AccessToken {
        do {
            return AccessToken(try await requestToken([
                "grant_type": "refresh_token",
                "refresh_token": refreshToken,
            ]))
        } catch let AuthError.tokenEndpoint(status, body) where status == 400 && body.contains("invalid_grant") {
            throw AuthError.reauthenticationRequired
        }
    }

    func authorizationURL(redirectURI: String, pkce: PKCE, state: String) -> URL {
        var components = URLComponents(url: Self.authorizationURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: config.clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: Self.scopes.joined(separator: " ")),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            // Forces Google to issue a refresh token even when the account was connected before.
            URLQueryItem(name: "prompt", value: "consent select_account"),
        ]
        return components.url!
    }

    private func requestToken(_ fields: [String: String]) async throws -> TokenResponse {
        var fields = fields
        fields["client_id"] = config.clientID
        fields["client_secret"] = config.clientSecret
        let (data, response) = try await transport.send(.form(Self.tokenURL, fields))
        guard response.statusCode == 200 else {
            throw AuthError.tokenEndpoint(status: response.statusCode, body: String(decoding: data, as: UTF8.self))
        }
        return try JSONDecoder().decode(TokenResponse.self, from: data)
    }
}

struct AccessToken: Sendable {
    var value: String
    var expiresAt: Date

    init(value: String, expiresAt: Date) {
        self.value = value
        self.expiresAt = expiresAt
    }

    init(_ response: TokenResponse, now: Date = .now) {
        value = response.access_token
        expiresAt = now.addingTimeInterval(TimeInterval(response.expires_in))
    }
}

public protocol AccessTokenProvider: Sendable {
    func accessToken(forceRefresh: Bool) async throws -> String
}

actor GoogleTokenProvider: AccessTokenProvider {
    private let oauth: GoogleOAuth
    private let refreshToken: String
    private var current: AccessToken?
    private var pendingRefresh: Task<AccessToken, any Error>?

    init(oauth: GoogleOAuth, refreshToken: String, initial: AccessToken? = nil) {
        self.oauth = oauth
        self.refreshToken = refreshToken
        current = initial
    }

    func accessToken(forceRefresh: Bool) async throws -> String {
        if !forceRefresh, let current, current.expiresAt.timeIntervalSinceNow > 60 {
            return current.value
        }
        if let pendingRefresh { return try await pendingRefresh.value.value }
        let task = Task { [oauth, refreshToken] in try await oauth.refresh(refreshToken) }
        pendingRefresh = task
        defer { pendingRefresh = nil }
        let token = try await task.value
        current = token
        return token.value
    }
}
