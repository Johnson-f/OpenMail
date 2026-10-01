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

/// Generic-password items in the login Keychain, grouped under one service name.
public struct KeychainStore: Sendable {
    private let service: String

    public init(service: String) {
        self.service = service
    }

    public func string(for account: String) throws -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func set(_ value: String, for account: String) throws {
        let data = Data(value.utf8)
        let status = SecItemUpdate(baseQuery(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery(account)
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    public func remove(_ account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

public struct KeychainTokenStore: TokenStore {
    private let keychain: KeychainStore

    public init(service: String = "app.openmail.google-refresh-token") {
        keychain = KeychainStore(service: service)
    }

    public func refreshToken(for accountID: String) throws -> String? {
        try keychain.string(for: accountID)
    }

    public func setRefreshToken(_ token: String, for accountID: String) throws {
        try keychain.set(token, for: accountID)
    }

    public func removeRefreshToken(for accountID: String) throws {
        try keychain.remove(accountID)
    }
}

public enum APIKeyKind: String, Sendable, CaseIterable {
    case anthropic
    case voyage
}

public protocol APIKeyStore: Sendable {
    func key(_ kind: APIKeyKind) throws -> String?
    func setKey(_ key: String?, for kind: APIKeyKind) throws
}

public struct KeychainAPIKeyStore: APIKeyStore {
    private let keychain = KeychainStore(service: "app.openmail.api-keys")

    public init() {}

    public func key(_ kind: APIKeyKind) throws -> String? {
        try keychain.string(for: kind.rawValue)
    }

    public func setKey(_ key: String?, for kind: APIKeyKind) throws {
        if let key, !key.isEmpty {
            try keychain.set(key, for: kind.rawValue)
        } else {
            try keychain.remove(kind.rawValue)
        }
    }
}
