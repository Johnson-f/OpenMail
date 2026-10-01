import Foundation
import Security

public protocol TokenStore: Sendable {
    func refreshToken(for accountID: String) throws -> String?
    func setRefreshToken(_ token: String, for accountID: String) throws
    func removeRefreshToken(for accountID: String) throws
}

public struct KeychainError: Error {
    public let status: OSStatus
}

public struct KeychainTokenStore: TokenStore {
    private let service: String

    public init(service: String = "app.openmail.google-refresh-token") {
        self.service = service
    }

    public func refreshToken(for accountID: String) throws -> String? {
        var query = baseQuery(accountID)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func setRefreshToken(_ token: String, for accountID: String) throws {
        let data = Data(token.utf8)
        let status = SecItemUpdate(baseQuery(accountID) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery(accountID)
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    public func removeRefreshToken(for accountID: String) throws {
        let status = SecItemDelete(baseQuery(accountID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private func baseQuery(_ accountID: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountID,
        ]
    }
}
