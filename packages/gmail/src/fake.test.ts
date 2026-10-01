import { describe, it, expect, beforeEach } from 'vitest'
import { FakeGmail } from './fake'
import { HistoryExpiredError, MessageNotFoundError, UncertainSendError } from './types'

describe('FakeGmail', () => {
  let gmail: FakeGmail

  beforeEach(() => {
    gmail = new FakeGmail({ pageSize: 2 })
  })

  it('paginates message ids across pages', async () => {
    gmail.seedMessage({ id: 'm1' })
    gmail.seedMessage({ id: 'm2' })
    gmail.seedMessage({ id: 'm3' })

    const page1 = await gmail.listMessageIds()
    expect(page1.ids).toEqual(['m1', 'm2'])
    expect(page1.nextPageToken).toBeDefined()

    const page2 = await gmail.listMessageIds(page1.nextPageToken)
    expect(page2.ids).toEqual(['m3'])
    expect(page2.nextPageToken).toBeUndefined()
  })

  it('records a labelAdded history entry', async () => {
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'] })
    const before = await gmail.getProfile()

    gmail.remoteModify('m1', ['STARRED'], [])

    const page = await gmail.listHistory(before.historyId)
    expect(page.changes).toEqual([{ type: 'labelAdded', messageId: 'm1', labelIds: ['STARRED'] }])

    const msg = await gmail.getMessage('m1')
    expect(msg.labelIds.sort()).toEqual(['INBOX', 'STARRED'])
  })

  it('records a labelRemoved history entry', async () => {
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX', 'UNREAD'] })
    const before = await gmail.getProfile()

    gmail.remoteModify('m1', [], ['UNREAD'])

    const page = await gmail.listHistory(before.historyId)
    expect(page.changes).toEqual([{ type: 'labelRemoved', messageId: 'm1', labelIds: ['UNREAD'] }])

    const msg = await gmail.getMessage('m1')
    expect(msg.labelIds).toEqual(['INBOX'])
  })

  it('treats removing an absent label as a silent no-op with no history entry', async () => {
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'] })
    const before = await gmail.getProfile()

    gmail.remoteModify('m1', [], ['STARRED'])

    const page = await gmail.listHistory(before.historyId)
    expect(page.changes).toEqual([])

    const after = await gmail.getProfile()
    expect(after.historyId).toEqual(before.historyId)

    const msg = await gmail.getMessage('m1')
    expect(msg.labelIds).toEqual(['INBOX'])
  })

  it('throws HistoryExpiredError when the cursor predates retention', async () => {
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'] })
    gmail.remoteModify('m1', ['STARRED'], [])
    const current = await gmail.getProfile()

    gmail.expireHistoryBefore(current.historyId)

    await expect(gmail.listHistory('0')).rejects.toThrow(HistoryExpiredError)
  })

  it('fails exactly the next modifyMessage call then recovers', async () => {
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'] })
    const boom = new Error('boom')
    gmail.failNextModify(boom)

    await expect(gmail.modifyMessage('m1', ['STARRED'], [])).rejects.toThrow('boom')

    // Failed call must not have applied any change.
    const msgAfterFailure = await gmail.getMessage('m1')
    expect(msgAfterFailure.labelIds).toEqual(['INBOX'])

    await expect(gmail.modifyMessage('m1', ['STARRED'], [])).resolves.toBeUndefined()
    const msgAfterRecovery = await gmail.getMessage('m1')
    expect(msgAfterRecovery.labelIds.sort()).toEqual(['INBOX', 'STARRED'])
  })

  it('returns a defensive copy from getMessage', async () => {
    gmail.seedMessage({ id: 'm1', labelIds: ['INBOX'], to: ['a@example.com'] })

    const msg = await gmail.getMessage('m1')
    msg.labelIds.push('STARRED')
    msg.to.push('mutated@example.com')

    const again = await gmail.getMessage('m1')
    expect(again.labelIds).toEqual(['INBOX'])
    expect(again.to).toEqual(['a@example.com'])
  })

  it('round-trips attachment bytes defensively', async () => {
    gmail.seedMessage({ id: 'm1' })
    gmail.seedAttachment('m1', 'a1', Buffer.from('secret'))

    const first = await gmail.getAttachment('m1', 'a1')
    first[0] = 0
    expect(Buffer.from(await gmail.getAttachment('m1', 'a1')).toString()).toBe('secret')
  })

  it('creates, updates, sends and reconciles a draft', async () => {
    const draft = await gmail.createDraft({
      to: ['a@example.com'],
      subject: 'First',
      bodyText: 'Body',
      messageId: 'draft-send@openmail.local',
    })
    await gmail.updateDraft(draft.id, {
      to: ['a@example.com'],
      subject: 'Updated',
      bodyText: 'Updated body',
      messageId: 'draft-send@openmail.local',
    })

    const sent = await gmail.sendDraft(draft.id)
    expect(sent.rfcMessageId).toBe('draft-send@openmail.local')
    expect((await gmail.findByRfcMessageId(sent.rfcMessageId))?.subject).toBe('Updated')
  })

  it('marks a failed send as uncertain and never applies it', async () => {
    gmail.failNextSend(new Error('connection dropped'))
    await expect(
      gmail.sendMessage({
        to: ['a@example.com'],
        subject: 'Do not duplicate',
        bodyText: 'Body',
        messageId: 'uncertain@openmail.local',
      }),
    ).rejects.toMatchObject({ name: 'UncertainSendError' })
    expect(await gmail.findByRfcMessageId('uncertain@openmail.local')).toBeNull()
  })

  it('throws MessageNotFoundError for unknown messages', async () => {
    await expect(gmail.getMessage('missing')).rejects.toBeInstanceOf(MessageNotFoundError)
  })

  it('records a messageDeleted history entry on permanent deletion', async () => {
    gmail.seedMessage({ id: 'm1' })
    const before = await gmail.getProfile()
    gmail.deleteMessagePermanently('m1')
    const page = await gmail.listHistory(before.historyId)
    expect(page.changes).toEqual([{ type: 'messageDeleted', messageId: 'm1' }])
    await expect(gmail.getMessage('m1')).rejects.toBeInstanceOf(MessageNotFoundError)
    expect((await gmail.listMessageIds()).ids).toEqual([])
  })

  it('stores a send whose acknowledgement is lost', async () => {
    gmail.failNextSendAfterAccept(new Error('socket hang up'))
    await expect(
      gmail.sendMessage({ to: ['a@b.com'], subject: 's', bodyText: 'b', messageId: 'op-1@openmail.local' }),
    ).rejects.toBeInstanceOf(UncertainSendError)
    expect(gmail.sendCount).toBe(1)
    expect(await gmail.findByRfcMessageId('op-1@openmail.local')).not.toBeNull()
  })

  it('does not count a send that failed before acceptance', async () => {
    gmail.failNextSend(new Error('offline'))
    await expect(
      gmail.sendMessage({ to: ['a@b.com'], subject: 's', bodyText: 'b', messageId: 'op-2@openmail.local' }),
    ).rejects.toBeInstanceOf(UncertainSendError)
    expect(gmail.sendCount).toBe(0)
    expect(await gmail.findByRfcMessageId('op-2@openmail.local')).toBeNull()
  })
})
