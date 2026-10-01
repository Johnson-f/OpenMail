import { randomUUID } from 'node:crypto'
import type { AgentRuntime, AssistantAnswer, ConversationTurn } from '@gmail/agent'
import type { Db } from '../db/index'
import type { StoredConversationMessage } from '../ipc/contract'

export type ConversationSummary = {
  id: string
  title: string
  accountIds: number[]
  updatedAt: number
}

const HISTORY_TURNS = 6
const HISTORY_MESSAGE_CHARACTERS = 2000

export class AssistantService {
  constructor(
    private readonly db: Db,
    private readonly runtime: Pick<AgentRuntime, 'ask'>,
  ) {}

  listConversations(): ConversationSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, title, account_scope_json AS scope, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC',
      )
      .all() as Array<{ id: string; title: string; scope: string; updatedAt: number }>
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      accountIds: JSON.parse(row.scope) as number[],
      updatedAt: row.updatedAt,
    }))
  }

  conversationMessages(conversationId: string): StoredConversationMessage[] {
    const rows = this.db
      .prepare(
        'SELECT id, role, content_json AS content, created_at AS createdAt FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid',
      )
      .all(conversationId) as Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: number }>
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: JSON.parse(row.content) as StoredConversationMessage['content'],
      createdAt: row.createdAt,
    }))
  }

  async ask(input: {
    conversationId?: string
    question: string
    accountIds: number[]
    threadIds?: string[]
    signal?: AbortSignal
  }): Promise<AssistantAnswer & { conversationId: string }> {
    const conversationId = input.conversationId ?? randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, account_scope_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_scope_json = excluded.account_scope_json, updated_at = excluded.updated_at`,
      )
      .run(conversationId, input.question.slice(0, 80), JSON.stringify(input.accountIds), now, now)
    const { history, referencedMessageIds } = this.priorContext(conversationId)
    this.insertMessage(conversationId, 'user', { text: input.question }, now)
    const answer = await this.runtime.ask({
      conversationId,
      question: input.question,
      accountIds: input.accountIds,
      threadIds: input.threadIds,
      history,
      referencedMessageIds,
      signal: input.signal,
    })
    this.insertMessage(conversationId, 'assistant', answer, Date.now())
    return { conversationId, ...answer }
  }

  private priorContext(conversationId: string): {
    history: ConversationTurn[]
    referencedMessageIds: string[]
  } {
    const recent = this.conversationMessages(conversationId).slice(-HISTORY_TURNS * 2)
    const history = recent.map((message) => ({
      role: message.role,
      text: messageText(message.content).slice(0, HISTORY_MESSAGE_CHARACTERS),
    }))
    const lastAnswer = [...recent].reverse().find((message) => message.role === 'assistant')
    const evidence = lastAnswer && 'evidence' in lastAnswer.content ? lastAnswer.content.evidence : []
    return { history, referencedMessageIds: [...new Set(evidence.map((item) => item.messageId))] }
  }

  private insertMessage(conversationId: string, role: string, content: unknown, createdAt: number): void {
    this.db
      .prepare(
        'INSERT INTO conversation_messages (id, conversation_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), conversationId, role, JSON.stringify(content), createdAt)
  }
}

function messageText(content: StoredConversationMessage['content']): string {
  return 'answer' in content ? content.answer : content.text
}
