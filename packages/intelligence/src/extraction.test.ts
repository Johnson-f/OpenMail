import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '@gmail/core'
import { extractAttachment } from './extraction'

function ref(mimeType: string, filename: string): AttachmentRef {
  return {
    partId: '1',
    filename,
    mimeType,
    sizeBytes: 1,
    disposition: 'attachment',
  }
}

describe('extractAttachment', () => {
  it('extracts text and sanitizes HTML locally', async () => {
    const result = await extractAttachment({
      ref: ref('text/html', 'mail.html'),
      data: Buffer.from('<p>Hello &amp; welcome</p><script>steal()</script>'),
    })
    expect(result).toEqual({
      status: 'readable',
      sections: [{ location: 'document', text: 'Hello & welcome' }],
    })
  })

  it('uses an injected local OCR adapter for images', async () => {
    const result = await extractAttachment(
      { ref: ref('image/png', 'invoice.png'), data: Buffer.from('image') },
      { ocr: async () => 'Invoice total $42' },
    )
    expect(result.sections[0]?.text).toBe('Invoice total $42')
  })

  it('marks oversized and unsupported inputs explicitly', async () => {
    await expect(
      extractAttachment(
        { ref: ref('application/octet-stream', 'large.bin'), data: Buffer.alloc(20) },
        { maxBytes: 10 },
      ),
    ).resolves.toMatchObject({ status: 'oversized' })
    await expect(
      extractAttachment({ ref: ref('application/octet-stream', 'unknown.bin'), data: Buffer.from('x') }),
    ).resolves.toMatchObject({ status: 'unsupported' })
  })
})
