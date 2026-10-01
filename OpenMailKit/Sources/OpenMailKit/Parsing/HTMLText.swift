import Foundation

enum HTMLText {
    /// Converts an email HTML body to readable plain text. Used for search and AI input, not display.
    static func plainText(fromHTML html: String) -> String {
        var text = html
        text = text.replacing(/(?is)<(head|style|script|title)\b.*?<\/\1\s*>/, with: "")
        text = text.replacing(/(?is)<!--.*?-->/, with: "")
        text = text.replacing(/(?i)<br\s*\/?>/, with: "\n")
        text = text.replacing(/(?i)<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/, with: "\n")
        text = text.replacing(/(?i)<li\b[^>]*>/, with: "• ")
        text = text.replacing(/(?s)<[^>]+>/, with: "")
        text = decodeEntities(text)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacing(/[ \t\u{00A0}]+/, with: " ").trimmingCharacters(in: .whitespaces) }
        return lines.joined(separator: "\n")
            .replacing(/\n{3,}/, with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func decodeEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        return text.replacing(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/) { match in
            let entity = String(match.output.1)
            if entity.hasPrefix("#x") || entity.hasPrefix("#X") {
                return UInt32(entity.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String($0) } ?? String(match.output.0)
            }
            if entity.hasPrefix("#") {
                return UInt32(entity.dropFirst()).flatMap(Unicode.Scalar.init).map { String($0) } ?? String(match.output.0)
            }
            return namedEntities[entity] ?? String(match.output.0)
        }
    }

    private static let namedEntities: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{00A0}",
        "ndash": "–", "mdash": "—", "hellip": "…", "lsquo": "‘", "rsquo": "’",
        "ldquo": "“", "rdquo": "”", "copy": "©", "reg": "®", "trade": "™",
        "euro": "€", "pound": "£", "bull": "•", "middot": "·", "zwnj": "", "shy": "",
    ]
}
