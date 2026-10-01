import Foundation
@testable import OpenMailKit
import Testing

struct AuthTests {
    @Test func pkceChallengeMatchesRFC7636Example() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func authorizationURLRequestsOfflineAccessWithPKCE() throws {
        let oauth = GoogleOAuth(config: GoogleOAuthConfig(clientID: "cid", clientSecret: "secret"), transport: URLSessionTransport())
        let pkce = PKCE(verifier: "verifier")
        let url = oauth.authorizationURL(redirectURI: "http://127.0.0.1:5000", pkce: pkce, state: "xyz")
        let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(query["client_id"] == "cid")
        #expect(query["redirect_uri"] == "http://127.0.0.1:5000")
        #expect(query["code_challenge"] == pkce.challenge)
        #expect(query["code_challenge_method"] == "S256")
        #expect(query["access_type"] == "offline")
        #expect(query["scope"] == "https://www.googleapis.com/auth/gmail.modify")
    }

    @Test func loopbackParsesCallbackQuery() {
        let request = Data("GET /?state=abc&code=4%2F0Ab HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8)
        #expect(LoopbackServer.queryParameters(fromRequest: request) == ["state": "abc", "code": "4/0Ab"])
    }

    @Test func loopbackServerDeliversCallback() async throws {
        let server = try await LoopbackServer.start()
        defer { server.stop() }
        async let params = server.waitForCallback()
        let url = URL(string: "http://127.0.0.1:\(server.port)/?code=abc&state=s1")!
        let (_, response) = try await URLSession.shared.data(from: url)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(try await params == ["code": "abc", "state": "s1"])
    }

    @Test func formEncodingEscapesPlus() throws {
        let request = URLRequest.form(URL(string: "https://example.com")!, ["code": "a+b/c", "x": "1 2"])
        let body = String(decoding: try #require(request.httpBody), as: UTF8.self)
        #expect(body == "code=a%2Bb/c&x=1%202")
    }
}
