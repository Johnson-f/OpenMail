import { describe, it, expect, beforeEach } from 'vitest'
import { FakeGmail } from './fake'
import { HistoryExpiredError } from './types'

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
})
