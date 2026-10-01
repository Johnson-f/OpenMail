import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { ActionApprovalGraph, PolicyEngine } from '@gmail/agent'
import { FakeGmail } from '@gmail/gmail'
import { openAgentDatabase, openDatabase } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { ActionService } from './action-service'
import { AssistantToolService } from './assistant-tool-service'
import { MailActionService } from './mail-action-service'

async function setup() {
  const mailDb = openDatabase(':memory:')
  const agentDb = openAgentDatabase(':memory:')
  const gmail = new FakeGmail()
  gmail.seedMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })
  const store = new SqliteMailStore(mailDb)
  store.upsertMessage(1, await gmail.getMessage('m1'))
  const actions = new ActionService(
    agentDb,
    new PolicyEngine(),
    new ActionApprovalGraph(new MemorySaver()),
  )
  const mailActions = new MailActionService(mailDb, store, () => gmail, actions)
  return {
    mailDb,
    agentDb,
    store,
    actions,
    tools: new AssistantToolService(store, actions, mailActions, (accountId, threadIds) =>
      (mailDb.prepare('SELECT id FROM messages WHERE account_id = ? AND thread_id = ?').all(accountId, threadIds[0]) as Array<{ id: string }>).map((row) => row.id),
    ),
  }
}

const context = {
  conversationId: 'c1',
  accountIds: [1],
  question: 'Archive this email',
  evidence: [{ messageId: 'm1' }] as never,
}

describe('AssistantToolService', () => {
  it('creates a Gmail draft without sending it', async () => {
    const { mailDb, agentDb, tools } = await setup()
    const result = await tools.execute(
      {
        id: 'call-1',
        name: 'create_draft',
        arguments: { to: ['alice@example.com'], subject: 'Renewal', bodyText: 'Confirmed.' },
      },
      context,
    )
    expect(result).toMatchObject({ status: 'completed', message: expect.stringContaining('Draft saved') })
    expect((mailDb.prepare('SELECT COUNT(*) AS count FROM local_drafts').get() as { count: number }).count).toBe(1)
    mailDb.close(); agentDb.close()
  })

  it('executes a small reversible action immediately', async () => {
    const { mailDb, agentDb, store, tools } = await setup()
    const result = await tools.execute(
      { id: 'call-2', name: 'archive_messages', arguments: { messageIds: ['m1'] } },
      context,
    )
    expect(result.status).toBe('completed')
    expect(store.pendingOutbox(1)).toEqual([
      expect.objectContaining({ messageId: 'm1', add: [], remove: ['INBOX'] }),
    ])
    mailDb.close(); agentDb.close()
  })

  it('persists destructive work for approval and executes only after review', async () => {
    const { mailDb, agentDb, store, actions, tools } = await setup()
    const pending = await tools.execute(
      { id: 'call-3', name: 'trash_messages', arguments: { messageIds: ['m1'] } },
      context,
    )
    expect(pending.status).toBe('pending')
    expect(store.pendingOutbox(1)).toEqual([])
    const intent = actions.listPending()[0]!.intent
    await actions.review(intent.id, intent.contentHash, true)
    expect(tools.executeApproved(intent.id).status).toBe('completed')
    expect(store.pendingOutbox(1)).toEqual([
      expect.objectContaining({ messageId: 'm1', add: ['TRASH'], remove: ['INBOX'] }),
    ])
    mailDb.close(); agentDb.close()
  })

  it('prepares sends for exact approval and rejects ambiguous multi-account actions', async () => {
    const { mailDb, agentDb, tools } = await setup()
    const send = await tools.execute(
      {
        id: 'call-4',
        name: 'send_email',
        arguments: { to: ['alice@example.com'], subject: 'Hello', bodyText: 'Hi' },
      },
      context,
    )
    expect(send.status).toBe('pending')
    const denied = await tools.execute(
      { id: 'call-5', name: 'archive_messages', arguments: { messageIds: ['m1'] } },
      { ...context, accountIds: [1, 2] },
    )
    expect(denied.status).toBe('denied')
    mailDb.close(); agentDb.close()
  })

  it('denies mailbox actions without explicit messageIds', async () => {
    const { mailDb, agentDb, store, tools } = await setup()
    const result = await tools.execute({ id: 'c', name: 'archive_messages', arguments: {} }, context)
    expect(result.status).toBe('denied')
    expect(store.pendingOutbox(1)).toEqual([])
    mailDb.close(); agentDb.close()
  })

  it('denies ids outside evidence, referenced ids and selected threads', async () => {
    const { mailDb, agentDb, store, tools } = await setup()
    const result = await tools.execute(
      { id: 'c', name: 'archive_messages', arguments: { messageIds: ['m1', 'other'] } },
      context,
    )
    expect(result.status).toBe('denied')
    expect(store.pendingOutbox(1)).toEqual([])
    mailDb.close(); agentDb.close()
  })

  it('allows ids from referencedMessageIds and from selected threads', async () => {
    const { mailDb, agentDb, store, tools } = await setup()
    const base = { ...context, evidence: [] }
    const referenced = await tools.execute(
      { id: 'c1', name: 'archive_messages', arguments: { messageIds: ['m1'] } },
      { ...base, referencedMessageIds: ['m1'] },
    )
    expect(referenced.status).toBe('completed')
    const threadId = (mailDb.prepare("SELECT thread_id FROM messages WHERE id = 'm1'").get() as { thread_id: string }).thread_id
    const viaThread = await tools.execute(
      { id: 'c2', name: 'mark_messages_read', arguments: { messageIds: ['m1'], read: true } },
      { ...base, threadIds: [threadId] },
    )
    expect(viaThread.status).toBe('completed')
    expect(store.pendingOutbox(1).length).toBeGreaterThan(0)
    mailDb.close(); agentDb.close()
  })

  it('treats label_messages that adds TRASH as a pending trash', async () => {
    const { mailDb, agentDb, store, tools } = await setup()
    const result = await tools.execute(
      { id: 'c', name: 'label_messages', arguments: { messageIds: ['m1'], add: ['TRASH'] } },
      context,
    )
    expect(result.status).toBe('pending')
    expect(store.pendingOutbox(1)).toEqual([])
    mailDb.close(); agentDb.close()
  })
})
