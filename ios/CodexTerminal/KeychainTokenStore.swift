import Foundation
import Security

enum KeychainTokenStore {
    private static let account = "admin-token"
    private static var service: String {
        Bundle.main.bundleIdentifier ?? "com.codexswitch.terminal"
    }

    static func read() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8)
        else {
            return ""
        }
        return token
    }

    @discardableResult
    static func write(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        if trimmed.isEmpty {
            let status = SecItemDelete(lookup as CFDictionary)
            return status == errSecSuccess || status == errSecItemNotFound
        }

        let encoded = Data(trimmed.utf8)
        let update: [String: Any] = [kSecValueData as String: encoded]
        let updateStatus = SecItemUpdate(lookup as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess {
            return true
        }
        guard updateStatus == errSecItemNotFound else {
            return false
        }

        var item = lookup
        item[kSecValueData as String] = encoded
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }
}
