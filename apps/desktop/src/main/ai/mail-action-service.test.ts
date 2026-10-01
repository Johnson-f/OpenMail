import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import { ActionApprovalGraph, PolicyEngine } from '@gmail/agent'
import { FakeGmail, UncertainSendError } from '@gmail/gmail'
import { openAgentDatabase, openDatabase } from '../db/index'
import { SqliteMailStore } from '../db/store'
import { ActionService } from './action-service'
import { MailActionService } from './mail-action-service'

function setup() {
  const mailDb = openDatabase(':memory:')
  const agentDb = openAgentDatabase(':memory:')
  const gmail = new FakeGmail()
  const actions = new ActionService(agentDb, new PolicyEngine(), new ActionApprovalGraph(new MemorySaver()))
  const service = new MailActionService(mailDb, new SqliteMailStore(mailDb), () => gmail, actions)
  return { mailDb, agentDb, gmail, actions, service }
}

describe('MailActionService', () => {
  it('saves and updates a remote draft', async () => {
    const { mailDb, agentDb, service } = setup()
    const first = await service.saveDraft(1, undefined, {
      to: ['a@example.com'],
      subject: 'Draft',
      bodyText: 'First',
    })
    const updated = await service.saveDraft(1, first.localDraftId, {
      to: ['a@example.com'],
      subject: 'Draft',
      bodyText: 'Updated',
    })
    expect(updated.localDraftId).toBe(first.localDraftId)
    expect((mailDb.prepare('SELECT COUNT(*) AS count FROM local_drafts').get() as { count: number }).count).toBe(1)
    mailDb.close(); agentDb.close()
  })

  it('requires exact approval and sends once with a ledger', async () => {
    const { mailDb, agentDb, actions, service } = setup()
    const pending = await service.requestSend(1, {
      to: ['a@example.com'],
      subject: 'Approved',
      bodyText: 'Hello',
    })
    expect(pending.status).toBe('pending')
    await actions.review(pending.intent.id, pending.intent.contentHash, true)

    const first = await service.executeApproved(pending.intent.id)
    const second = await service.executeApproved(pending.intent.id)

    expect(first.status).toBe('sent')
    expect(second).toEqual(first)
    expect((mailDb.prepare("SELECT COUNT(*) AS count FROM send_ledger WHERE status = 'sent'").get() as { count: number }).count).toBe(1)
    mailDb.close(); agentDb.close()
  })

  it('keeps uncertain sends from retrying and reconciles by Message-ID', async () => {
    const { mailDb, agentDb, gmail, actions, service } = setup()
    const pending = await service.requestSend(1, { to: ['a@example.com'], subject: 'Maybe', bodyText: 'Body' })
    await actions.review(pending.intent.id, pending.intent.contentHash, true)
    gmail.failNextSend(new Error('connection dropped'))
    const uncertain = await service.executeApproved(pending.intent.id)
    expect(uncertain.status).toBe('uncertain')
    await expect(service.executeApproved(pending.intent.id)).resolves.toMatchObject({ status: 'uncertain' })

    const message = pending.intent.arguments.message as { messageId: string }
    gmail.seedMessage({ id: 'accepted', labelIds: ['SENT'], messageIdHeader: message.messageId })
    const operationId = String(pending.intent.arguments.operationId)
    await expect(service.reconcileUncertain(operationId)).resolves.toMatchObject({ status: 'sent' })
    mailDb.close(); agentDb.close()
  })

  async function approvedSend(ctx: ReturnType<typeof setup>, subject: string) {
    const pending = await ctx.service.requestSend(1, { to: ['a@example.com'], subject, bodyText: 'Body' })
    await ctx.actions.review(pending.intent.id, pending.intent.contentHash, true)
    return pending.intent
  }

  it('sends once when executeApproved runs concurrently', async () => {
    const ctx = setup()
    const intent = await approvedSend(ctx, 'Race')
    const results = await Promise.all([ctx.service.executeApproved(intent.id), ctx.service.executeApproved(intent.id)])
    expect(ctx.gmail.sendCount).toBe(1)
    expect(results.map((item) => item.status).sort()).toEqual(['in_progress', 'sent'])
    ctx.mailDb.close(); ctx.agentDb.close()
  })

  it('reconciles an accepted-but-unacknowledged send without sending again', async () => {
    const ctx = setup()
    const intent = await approvedSend(ctx, 'Lost ack')
    ctx.gmail.failNextSendAfterAccept(new UncertainSendError('ack lost'))
    expect((await ctx.service.executeApproved(intent.id)).status).toBe('uncertain')
    await ctx.service.reconcilePending(1)
    const ledger = ctx.mailDb.prepare('SELECT status FROM send_ledger').get() as { status: string }
    expect(ledger.status).toBe('sent')
    expect(ctx.actions.status(intent.id)).toBe('completed')
    expect(ctx.gmail.sendCount).toBe(1)
    ctx.mailDb.close(); ctx.agentDb.close()
  })

  it('marks an unseen send not_sent after 15 minutes and allows a fresh approval to resend', async () => {
    const ctx = setup()
    const intent = await approvedSend(ctx, 'Dropped')
    ctx.gmail.failNextSend(new UncertainSendError('dropped'))
    expect((await ctx.service.executeApproved(intent.id)).status).toBe('uncertain')
    await ctx.service.reconcilePending(1)
    expect((ctx.mailDb.prepare('SELECT status FROM send_ledger').get() as { status: string }).status).toBe('uncertain')

    await ctx.service.reconcilePending(1, Date.now() + 16 * 60_000)
    expect((ctx.mailDb.prepare('SELECT status FROM send_ledger').get() as { status: string }).status).toBe('not_sent')
    expect(ctx.actions.status(intent.id)).toBe('failed')
    expect(ctx.service.listNotSent()).toHaveLength(1)

    const again = await ctx.service.resend(intent.id)
    expect(again.status).toBe('pending')
    expect(again.intent.arguments.operationId).not.toBe(intent.arguments.operationId)
    expect(ctx.service.listNotSent()).toHaveLength(0)
    await expect(ctx.service.resend(intent.id)).rejects.toThrow()
    ctx.mailDb.close(); ctx.agentDb.close()
  })

  it('turns sends interrupted mid-flight into uncertain on recovery', async () => {
    const ctx = setup()
    const intent = await approvedSend(ctx, 'Crash')
    ctx.mailDb
      .prepare(
        `INSERT INTO send_ledger (operation_id, action_intent_id, account_id, rfc_message_id, content_hash, status, created_at, updated_at)
         VALUES ('op', ?, 1, 'rfc@x', 'h', 'sending', 1, 1)`,
      )
      .run(intent.id)
    expect(ctx.service.recoverInterrupted()).toBe(1)
    expect((ctx.mailDb.prepare('SELECT status FROM send_ledger').get() as { status: string }).status).toBe('uncertain')
    ctx.mailDb.close(); ctx.agentDb.close()
  })

  it('deletes the saved Gmail draft once its send goes out', async () => {
    const ctx = setup()
    const draft = await ctx.service.saveDraft(1, undefined, { to: ['a@example.com'], subject: 'Draft', bodyText: 'Body' })
    const deleteDraft = vi.spyOn(ctx.gmail, 'deleteDraft')
    const pending = await ctx.service.requestSend(
      1,
      { to: ['a@example.com'], subject: 'Draft', bodyText: 'Body' },
      'compose',
      draft.localDraftId,
    )
    await ctx.actions.review(pending.intent.id, pending.intent.contentHash, true)
    expect((await ctx.service.executeApproved(pending.intent.id)).status).toBe('sent')
    expect(deleteDraft).toHaveBeenCalledWith(draft.remote.id)
    expect(ctx.mailDb.prepare('SELECT COUNT(*) AS n FROM local_drafts').get()).toEqual({ n: 0 })
    ctx.mailDb.close(); ctx.agentDb.close()
  })

  it('keeps the draft when the send fails', async () => {
    const ctx = setup()
    const draft = await ctx.service.saveDraft(1, undefined, { to: ['a@example.com'], subject: 'Draft', bodyText: 'Body' })
    const pending = await ctx.service.requestSend(
      1,
      { to: ['a@example.com'], subject: 'Draft', bodyText: 'Body' },
      'compose',
      draft.localDraftId,
    )
    await ctx.actions.review(pending.intent.id, pending.intent.contentHash, true)
    vi.spyOn(ctx.gmail, 'sendMessage').mockRejectedValueOnce(new Error('400 invalid recipient'))
    expect((await ctx.service.executeApproved(pending.intent.id)).status).toBe('failed')
    expect(ctx.mailDb.prepare('SELECT COUNT(*) AS n FROM local_drafts').get()).toEqual({ n: 1 })
    ctx.mailDb.close(); ctx.agentDb.close()
  })

  it('offers a definitely failed send for a fresh approval', async () => {
    const ctx = setup()
    const intent = await approvedSend(ctx, 'Rejected')
    vi.spyOn(ctx.gmail, 'sendMessage').mockRejectedValueOnce(new Error('400 invalid recipient'))
    expect((await ctx.service.executeApproved(intent.id)).status).toBe('failed')
    expect(ctx.service.listNotSent().map((item) => item.intent.id)).toEqual([intent.id])
    const again = await ctx.service.resend(intent.id)
    expect(again.status).toBe('pending')
    expect(again.intent.arguments.operationId).not.toBe(intent.arguments.operationId)
    expect(ctx.service.listNotSent()).toEqual([])
    await expect(ctx.service.resend(intent.id)).rejects.toThrow()
    ctx.mailDb.close(); ctx.agentDb.close()
  })
})
