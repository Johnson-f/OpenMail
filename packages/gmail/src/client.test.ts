import { afterEach, describe, it, expect, vi } from 'vitest'
import type { gmail_v1 } from 'googleapis'
import { GoogleGmail, splitAddresses } from './client'
import { MessageNotFoundError } from './types'

describe('splitAddresses', () => {
  it('splits plain comma-separated addresses', () => {
    expect(splitAddresses('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com'])
  })

  it('keeps a quoted display name containing a comma intact', () => {
    expect(splitAddresses('"Doe, John" <j@x.com>, b@y.com')).toEqual([
      '"Doe, John" <j@x.com>',
      'b@y.com',
    ])
  })

  it('handles several quoted names with commas', () => {
    expect(
      splitAddresses('"Smith, Jane" <j@a.com>, "Wu, Li" <l@b.com>'),
    ).toEqual(['"Smith, Jane" <j@a.com>', '"Wu, Li" <l@b.com>'])
  })

  it('does not split on a comma inside angle brackets', () => {
    expect(splitAddresses('Group <a@x.com,b@x.com>, c@y.com')).toEqual([
      'Group <a@x.com,b@x.com>',
      'c@y.com',
    ])
  })

  it('respects a backslash-escaped quote in a display name', () => {
    expect(splitAddresses('"He said \\"hi\\", really" <h@x.com>, b@y.com')).toEqual([
      '"He said \\"hi\\", really" <h@x.com>',
      'b@y.com',
    ])
  })

  it('returns an empty list for an empty header', () => {
    expect(splitAddresses('')).toEqual([])
    expect(splitAddresses('   ')).toEqual([])
  })

  it('drops trailing separators rather than emitting blanks', () => {
    expect(splitAddresses('a@x.com,')).toEqual(['a@x.com'])
  })
})

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...extra })
}

type Stub = {
  get: ReturnType<typeof vi.fn>
  modify: ReturnType<typeof vi.fn>
  attachmentsGet: ReturnType<typeof vi.fn>
}

function stubClient(): { client: GoogleGmail; stub: Stub } {
  const stub: Stub = { get: vi.fn(), modify: vi.fn(), attachmentsGet: vi.fn() }
  const gmail = {
    users: {
      messages: { get: stub.get, modify: stub.modify, attachments: { get: stub.attachmentsGet } },
    },
  } as unknown as gmail_v1.Gmail
  return { client: new GoogleGmail(undefined as never, gmail), stub }
}

function message(payload: gmail_v1.Schema$MessagePart): { data: gmail_v1.Schema$Message } {
  return { data: { id: 'm1', threadId: 't1', payload: { headers: [], ...payload } } }
}

describe('GoogleGmail error handling', () => {
  afterEach(() => vi.useRealTimers())

  it('maps 404 to MessageNotFoundError for get, modify and attachments', async () => {
    const { client, stub } = stubClient()
    stub.get.mockRejectedValue(httpError(404))
    stub.modify.mockRejectedValue(httpError(404))
    stub.attachmentsGet.mockRejectedValue(httpError(404))

    await expect(client.getMessage('m1')).rejects.toBeInstanceOf(MessageNotFoundError)
    await expect(client.modifyMessage('m1', [], ['INBOX'])).rejects.toBeInstanceOf(MessageNotFoundError)
    await expect(client.getAttachment('m1', 'a1')).rejects.toBeInstanceOf(MessageNotFoundError)
    expect(stub.get).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 403 that is not a rate limit', async () => {
    const { client, stub } = stubClient()
    stub.get.mockRejectedValue(
      httpError(403, { response: { data: { error: { errors: [{ reason: 'insufficientPermissions' }] } } } }),
    )

    await expect(client.getMessage('m1')).rejects.toThrow('HTTP 403')
    expect(stub.get).toHaveBeenCalledTimes(1)
  })

  it('retries a 403 rate limit', async () => {
    vi.useFakeTimers()
    const { client, stub } = stubClient()
    stub.get
      .mockRejectedValueOnce(
        httpError(403, { response: { data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }),
      )
      .mockResolvedValueOnce(message({ mimeType: 'text/plain', body: { data: b64('hi') } }))

    const pending = client.getMessage('m1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await pending).bodyText).toBe('hi')
    expect(stub.get).toHaveBeenCalledTimes(2)
  })

  it('honours Retry-After on 429', async () => {
    vi.useFakeTimers()
    const { client, stub } = stubClient()
    stub.get
      .mockRejectedValueOnce(httpError(429, { response: { headers: { 'retry-after': '7' } } }))
      .mockResolvedValueOnce(message({ mimeType: 'text/plain', body: { data: b64('hi') } }))

    const pending = client.getMessage('m1')
    await vi.advanceTimersByTimeAsync(6_999)
    expect(stub.get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(stub.get).toHaveBeenCalledTimes(2)
  })

  it('caps Retry-After at the maximum delay', async () => {
    vi.useFakeTimers()
    const { client, stub } = stubClient()
    stub.get
      .mockRejectedValueOnce(httpError(503, { response: { headers: { 'retry-after': '3600' } } }))
      .mockResolvedValueOnce(message({ mimeType: 'text/plain', body: { data: b64('hi') } }))

    const pending = client.getMessage('m1')
    await vi.advanceTimersByTimeAsync(30_000)
    await pending
    expect(stub.get).toHaveBeenCalledTimes(2)
  })
})

describe('GoogleGmail body extraction', () => {
  it('fetches a large body that only carries an attachmentId', async () => {
    const { client, stub } = stubClient()
    stub.get.mockResolvedValue(message({ mimeType: 'text/plain', body: { attachmentId: 'big', size: 9_000_000 } }))
    stub.attachmentsGet.mockResolvedValue({ data: { data: b64('a very large body') } })

    const result = await client.getMessage('m1')

    expect(result.bodyText).toBe('a very large body')
    expect(result.attachments).toEqual([])
    expect(stub.attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'm1', id: 'big' })
  })

  it('treats an attached .txt as an attachment, not the body', async () => {
    const { client, stub } = stubClient()
    stub.get.mockResolvedValue(
      message({
        mimeType: 'multipart/mixed',
        parts: [
          { partId: '0', mimeType: 'text/plain', body: { data: b64('real body') } },
          {
            partId: '1',
            mimeType: 'text/plain',
            filename: 'notes.txt',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' }],
            body: { attachmentId: 'att1', size: 10 },
          },
        ],
      }),
    )

    const result = await client.getMessage('m1')

    expect(result.bodyText).toBe('real body')
    expect(result.attachments.map((a) => a.filename)).toEqual(['notes.txt'])
    expect(stub.attachmentsGet).not.toHaveBeenCalled()
  })

  it('does not let an attached .txt displace an empty body', async () => {
    const { client, stub } = stubClient()
    stub.get.mockResolvedValue(
      message({
        mimeType: 'multipart/mixed',
        parts: [
          {
            partId: '1',
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Disposition', value: 'attachment' }],
            body: { data: b64('attached text') },
          },
        ],
      }),
    )

    const result = await client.getMessage('m1')

    expect(result.bodyText).toBe('')
    expect(result.attachments).toHaveLength(1)
  })
})
