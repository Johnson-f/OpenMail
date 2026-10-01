import Foundation

public enum VoyageError: Error, Equatable, LocalizedError {
    case missingAPIKey
    case http(status: Int, message: String)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .missingAPIKey: "Add a Voyage API key in Settings to enable semantic search."
        case let .http(status, message): "Voyage API error \(status): \(message)"
        case .malformedResponse: "Voyage returned an unexpected response."
        }
    }
}

public protocol EmbeddingProvider: Sendable {
    var model: String { get }
    func embed(_ texts: [String], inputType: EmbeddingInputType) async throws -> [[Float]]
}

public enum EmbeddingInputType: String, Sendable {
    case document
    case query
}

public struct VoyageClient: EmbeddingProvider {
    public static let dimensions = 512
    private static let endpoint = URL(string: "https://api.voyageai.com/v1/embeddings")!
    private static let maxAttempts = 5

    public let model = "voyage-4"
    let apiKey: String
    let transport: any HTTPTransport

    public init(apiKey: String, transport: any HTTPTransport = URLSessionTransport()) {
        self.apiKey = apiKey
        self.transport = transport
    }

    public func embed(_ texts: [String], inputType: EmbeddingInputType) async throws -> [[Float]] {
        guard !texts.isEmpty else { return [] }
        struct Body: Encodable {
            var input: [String]
            var model: String
            var input_type: String
            var output_dimension: Int
        }
        struct Response: Decodable {
            struct Item: Decodable { var embedding: [Float]; var index: Int }
            var data: [Item]
        }
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(Body(
            input: texts,
            model: model,
            input_type: inputType.rawValue,
            output_dimension: Self.dimensions
        ))

        for attempt in 1...Self.maxAttempts {
            let (data, response) = try await transport.send(request)
            let status = response.statusCode
            if status == 200 {
                let items = try JSONDecoder().decode(Response.self, from: data).data
                guard items.count == texts.count else { throw VoyageError.malformedResponse }
                return items.sorted { $0.index < $1.index }.map(\.embedding)
            }
            if (status == 429 || (500..<600).contains(status)) && attempt < Self.maxAttempts {
                try await Task.sleep(for: .seconds(pow(2, Double(attempt))))
                continue
            }
            let message = (try? JSONValue.parse(data))?["detail"]?.stringValue ?? String(decoding: data, as: UTF8.self)
            throw VoyageError.http(status: status, message: message)
        }
        throw VoyageError.http(status: 0, message: "Request failed after \(Self.maxAttempts) attempts")
    }
}
