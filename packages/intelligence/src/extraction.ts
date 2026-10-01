import JSZip from 'jszip'
import type { AttachmentRef } from '@gmail/core'

export type ExtractedSection = { location: string; text: string }
export type ExtractionResult = {
  sections: ExtractedSection[]
  status: 'readable' | 'unsupported' | 'encrypted' | 'failed' | 'oversized'
  error?: string
}

export type AttachmentInput = { ref: AttachmentRef; data: Uint8Array }
export type Ocr = (data: Uint8Array, signal?: AbortSignal) => Promise<string>

export type ExtractionOptions = {
  maxBytes?: number
  maxPages?: number
  timeoutMs?: number
  ocr?: Ocr
  signal?: AbortSignal
}

export async function extractAttachment(
  input: AttachmentInput,
  opts: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024
  if (input.data.byteLength > maxBytes) return { sections: [], status: 'oversized' }
  const mime = input.ref.mimeType.toLowerCase()
  const filename = input.ref.filename.toLowerCase()
  const task = async (): Promise<ExtractionResult> => {
    try {
      if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
        const text = Buffer.from(input.data).toString('utf8')
        return {
          sections: [{ location: 'document', text: mime === 'text/html' ? htmlToText(text) : text }],
          status: 'readable',
        }
      }
      if (mime === 'application/pdf' || filename.endsWith('.pdf')) return extractPdf(input.data, opts.maxPages ?? 200)
      if (mime.includes('wordprocessingml') || filename.endsWith('.docx')) {
        const mammoth = await import('mammoth')
        const result = await mammoth.extractRawText({ buffer: Buffer.from(input.data) })
        return { sections: [{ location: 'document', text: result.value }], status: 'readable' }
      }
      if (mime.includes('spreadsheetml') || filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
        if (filename.endsWith('.xls')) return { sections: [], status: 'unsupported' }
        return extractXlsx(input.data)
      }
      if (mime.includes('presentationml') || filename.endsWith('.pptx')) return extractPptx(input.data)
      if (mime.startsWith('image/')) {
        const ocr = opts.ocr ?? defaultOcr
        const text = await ocr(input.data, opts.signal)
        return { sections: [{ location: 'image', text }], status: 'readable' }
      }
      return { sections: [], status: 'unsupported' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const encrypted = /password|encrypted/i.test(message)
      return { sections: [], status: encrypted ? 'encrypted' : 'failed', error: message }
    }
  }
  return withTimeout(task(), opts.timeoutMs ?? 30_000, opts.signal)
}

async function extractPdf(data: Uint8Array, maxPages: number): Promise<ExtractionResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await pdfjs.getDocument({ data: new Uint8Array(data), useWorkerFetch: false }).promise
  if (document.numPages > maxPages) return { sections: [], status: 'oversized' }
  const sections: ExtractedSection[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    sections.push({ location: `page:${pageNumber}`, text })
  }
  return { sections, status: 'readable' }
}

async function extractPptx(data: Uint8Array): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(data)
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const sections: ExtractedSection[] = []
  for (const name of names) {
    const xml = await zip.file(name)!.async('text')
    const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeEntities(match[1] ?? ''))
      .join(' ')
    sections.push({ location: `slide:${slideNumber(name)}`, text })
  }
  return { sections, status: 'readable' }
}

async function extractXlsx(data: Uint8Array): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(data)
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('text')
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si[ >][\s\S]*?<\/si>/g)].map((match) =>
        [...(match[0] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
          .map((text) => decodeEntities(text[1] ?? ''))
          .join(''),
      )
    : []
  const names = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
  const sections: ExtractedSection[] = []
  for (const name of names) {
    const xml = await zip.file(name)!.async('text')
    const rows = [...xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)].map((row) =>
      [...(row[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)]
        .map((cell) => {
          const attributes = cell[1] ?? ''
          const body = cell[2] ?? ''
          const inline = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body)?.[1]
          if (inline !== undefined) return decodeEntities(inline)
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
          return /\bt="s"/.test(attributes) ? (shared[Number(raw)] ?? '') : decodeEntities(raw)
        })
        .join(','),
    )
    sections.push({ location: `sheet:${sheetNumber(name)}`, text: rows.join('\n') })
  }
  return { sections, status: 'readable' }
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)
}

function sheetNumber(name: string): number {
  return Number(/sheet(\d+)\.xml$/.exec(name)?.[1] ?? 0)
}

async function defaultOcr(data: Uint8Array): Promise<string> {
  const tesseract = await import('tesseract.js')
  const result = await tesseract.recognize(Buffer.from(data), 'eng')
  return result.data.text
}

export function htmlToText(value: string): string {
  return decodeEntities(
    value
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x?[0-9a-f]+|\w+);/gi, (_all, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named[entity.toLowerCase()] ?? `&${entity};`
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`Extraction timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  const abort = new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  try {
    return await Promise.race([promise, timeout, abort])
  } finally {
    if (handle) clearTimeout(handle)
  }
}
