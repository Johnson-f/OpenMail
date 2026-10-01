import Foundation

enum AddressParser {
    /// Parses an RFC 5322 address list such as `"Doe, Jane" <jane@x.com>, bob@y.com`.
    static func parseList(_ header: String?) -> [EmailAddress] {
        guard let header else { return [] }
        return splitTopLevel(header).compactMap(parseOne)
    }

    static func parseOne(_ raw: String) -> EmailAddress? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let open = trimmed.lastIndex(of: "<"), let close = trimmed.lastIndex(of: ">"), open < close {
            let email = String(trimmed[trimmed.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
            guard email.contains("@") else { return nil }
            let name = unquote(String(trimmed[..<open]))
            return EmailAddress(name: name.isEmpty ? nil : name, email: email)
        }
        guard trimmed.contains("@"), !trimmed.contains(" ") else { return nil }
        return EmailAddress(email: trimmed)
    }

    private static func splitTopLevel(_ header: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var inQuotes = false
        var inAngle = false
        var escaped = false
        for character in header {
            if escaped {
                current.append(character)
                escaped = false
                continue
            }
            switch character {
            case "\\" where inQuotes: escaped = true; current.append(character)
            case "\"": inQuotes.toggle(); current.append(character)
            case "<" where !inQuotes: inAngle = true; current.append(character)
            case ">" where !inQuotes: inAngle = false; current.append(character)
            case "," where !inQuotes && !inAngle, ";" where !inQuotes && !inAngle:
                parts.append(current)
                current = ""
            default: current.append(character)
            }
        }
        parts.append(current)
        return parts
    }

    private static func unquote(_ name: String) -> String {
        var name = name.trimmingCharacters(in: .whitespaces)
        if name.count >= 2, name.hasPrefix("\""), name.hasSuffix("\"") {
            name = String(name.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "\"")
        }
        return name.trimmingCharacters(in: .whitespaces)
    }
}
