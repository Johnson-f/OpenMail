import Accelerate
import Foundation

/// Brute-force cosine search over every embedded chunk, held in memory as one contiguous matrix.
actor VectorIndex {
    private let store: MailStore
    private var chunkIDs: [Int64] = []
    private var accountIDs: [String] = []
    private var matrix: [Float] = []
    private var dimensions = 0
    private var lastLoadedID: Int64 = 0

    init(store: MailStore) {
        self.store = store
    }

    /// Loads chunks embedded since the last refresh. The indexer embeds in ID order, so new rows always have higher IDs.
    func refresh() async throws {
        let fresh = try await store.embeddedChunks(after: lastLoadedID)
        for chunk in fresh {
            if dimensions == 0 { dimensions = chunk.embedding.count }
            guard chunk.embedding.count == dimensions else { continue }
            chunkIDs.append(chunk.id)
            accountIDs.append(chunk.accountID)
            matrix.append(contentsOf: Self.normalized(chunk.embedding))
        }
        lastLoadedID = fresh.last?.id ?? lastLoadedID
    }

    func nearest(to query: [Float], limit: Int, accountIDs allowed: Set<String>?) -> [(chunkID: Int64, score: Float)] {
        let count = chunkIDs.count
        guard count > 0, query.count == dimensions else { return [] }
        let query = Self.normalized(query)
        var scores = [Float](repeating: 0, count: count)
        vDSP_mmul(matrix, 1, query, 1, &scores, 1, vDSP_Length(count), 1, vDSP_Length(dimensions))

        var ranked: [(chunkID: Int64, score: Float)] = []
        ranked.reserveCapacity(count)
        for index in 0..<count where allowed?.contains(accountIDs[index]) ?? true {
            ranked.append((chunkIDs[index], scores[index]))
        }
        ranked.sort { $0.score > $1.score }
        return Array(ranked.prefix(limit))
    }

    private static func normalized(_ vector: [Float]) -> [Float] {
        var norm: Float = 0
        vDSP_svesq(vector, 1, &norm, vDSP_Length(vector.count))
        norm = norm.squareRoot()
        guard norm > 0 else { return vector }
        var result = [Float](repeating: 0, count: vector.count)
        var divisor = norm
        vDSP_vsdiv(vector, 1, &divisor, &result, 1, vDSP_Length(vector.count))
        return result
    }
}
