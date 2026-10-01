import Foundation
import OpenMailKit

@MainActor
@Observable
final class AssistantModel {
    struct Turn: Identifiable {
        let id = UUID()
        var question: String
        var segments: [Segment] = []
        var error: String?
    }

    enum Segment: Identifiable {
        case text(id: UUID, String)
        case activity(id: UUID, String)
        case draft(DraftProposal)

        var id: UUID {
            switch self {
            case let .text(id, _), let .activity(id, _): id
            case let .draft(proposal): proposal.id
            }
        }
    }

    private(set) var turns: [Turn] = []
    private(set) var isRunning = false
    private(set) var citations: [String: CitationTarget] = [:]
    private var session: (any AssistantBackend)?
    private var task: Task<Void, Never>?

    func send(_ question: String, context: AssistantContext, engine: AssistantEngine, service: MailService) {
        let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isRunning else { return }
        turns.append(Turn(question: question))
        let index = turns.count - 1
        isRunning = true
        task = Task {
            defer { isRunning = false }
            do {
                let session = try await currentSession(engine: engine, service: service)
                for try await event in session.send(question, context: context) {
                    apply(event, to: index)
                }
            } catch is CancellationError {
                turns[index].error = "Stopped."
            } catch {
                turns[index].error = error.localizedDescription
            }
        }
    }

    func stop() {
        task?.cancel()
    }

    func reset() {
        stop()
        turns = []
        citations = [:]
        let previous = session
        session = nil
        Task { await previous?.close() }
    }

    private func currentSession(engine: AssistantEngine, service: MailService) async throws -> any AssistantBackend {
        if let session { return session }
        let session = try await service.makeAssistant(engine: engine)
        self.session = session
        return session
    }

    private func apply(_ event: AssistantEvent, to index: Int) {
        switch event {
        case let .text(delta):
            if case let .text(id, existing) = turns[index].segments.last {
                turns[index].segments[turns[index].segments.count - 1] = .text(id: id, existing + delta)
            } else {
                turns[index].segments.append(.text(id: UUID(), delta))
            }
        case let .activity(description):
            turns[index].segments.append(.activity(id: UUID(), description))
        case let .draft(proposal):
            turns[index].segments.append(.draft(proposal))
        case let .citations(targets):
            citations = targets
        }
    }
}
