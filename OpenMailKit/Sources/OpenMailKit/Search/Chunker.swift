import Foundation

/// Splits a message into embedding-sized passages, each prefixed with the message's headers for context.
enum Chunker {
    static let targetLength = 1_500
    static let maxChunksPerMessage = 12

    static func chunks(for message: Message) -> [String] {
        let header = header(for: message)
        let body = normalizedBody(message.bodyText)
        let source = body.isEmpty ? message.snippet : body
        let passages = pack(paragraphs(source)).prefix(maxChunksPerMessage)
        if passages.isEmpty { return [header] }
        return passages.map { header + "\n\n" + $0 }
    }

    static func header(for message: Message) -> String {
        var lines: [String] = []
        if let from = message.from { lines.append("From: \(from.formatted)") }
        if !message.to.isEmpty { lines.append("To: \(message.to.map(\.formatted).joined(separator: ", "))") }
        if !message.cc.isEmpty { lines.append("Cc: \(message.cc.map(\.formatted).joined(separator: ", "))") }
        lines.append("Date: \(message.date.formatted(.iso8601.year().month().day()))")
        lines.append("Subject: \(message.subject)")
        return lines.joined(separator: "\n")
    }

    /// Drops quoted reply history, which is already indexed with the earlier message it quotes.
    static func normalizedBody(_ text: String) -> String {
        var kept: [Substring] = []
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if isQuoteIntroduction(trimmed, next: lines.indices.contains(index + 1) ? lines[index + 1] : nil) { break }
            if trimmed.hasPrefix(">") { continue }
            kept.append(line)
        }
        return kept.joined(separator: "\n")
            .replacing(/[ \t]+/, with: " ")
            .replacing(/\n{3,}/, with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isQuoteIntroduction(_ line: String, next: Substring?) -> Bool {
        if line.hasPrefix("-----Original Message-----") { return true }
        guard line.hasPrefix("On ") else { return false }
        if line.hasSuffix("wrote:") { return true }
        return next?.trimmingCharacters(in: .whitespaces).hasSuffix("wrote:") == true
    }

    private static func paragraphs(_ text: String) -> [String] {
        text.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .flatMap(splitLong)
    }

    private static func splitLong(_ paragraph: String) -> [String] {
        guard paragraph.count > targetLength else { return [paragraph] }
        var pieces: [String] = []
        var current = ""
        paragraph.enumerateSubstrings(in: paragraph.startIndex..., options: .bySentences) { sentence, _, _, _ in
            guard let sentence else { return }
            if current.count + sentence.count > targetLength, !current.isEmpty {
                pieces.append(current)
                current = ""
            }
            current += sentence
        }
        if !current.isEmpty { pieces.append(current) }
        return pieces.flatMap { piece in
            stride(from: 0, to: piece.count, by: targetLength).map { offset in
                let start = piece.index(piece.startIndex, offsetBy: offset)
                let end = piece.index(start, offsetBy: targetLength, limitedBy: piece.endIndex) ?? piece.endIndex
                return String(piece[start..<end]).trimmingCharacters(in: .whitespaces)
            }
        }
    }

    private static func pack(_ paragraphs: [String]) -> [String] {
        var chunks: [String] = []
        var current = ""
        for paragraph in paragraphs {
            if !current.isEmpty, current.count + paragraph.count + 2 > targetLength {
                chunks.append(current)
                current = ""
            }
            current += current.isEmpty ? paragraph : "\n\n" + paragraph
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}
