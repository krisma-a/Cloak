// PLACEHOLDER SCANNING. Nothing here reads real text, and nothing is sent anywhere.
//
// Each function has the inputs and output the real one will have (see scanAi.ts, the one file that decides which
// version the screen uses). The fakes are good enough to try the whole screen: the progress bar moves, a dark or
// blank photo is "unreadable", a few boxes appear at fixed spots, and the redacted PDF is a real PDF file.

import type { Category } from '../ai/placeholders.ts'
import { brightness, tooDarkOrFlat, UnreadableScanError } from './scan.ts'
import type { OcrProgress, OcrResult, OcrWord, ScanBox } from './scan.ts'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D is not available.')
  return ctx
}

function blankCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// Where the fake "words" sit, as fractions of the page, and what each one pretends to be.
const FAKE_WORDS: ReadonlyArray<{ x: number; y: number; w: number; h: number; category: Category }> = [
  { x: 0.16, y: 0.16, w: 0.3, h: 0.035, category: 'PERSON' },
  { x: 0.58, y: 0.16, w: 0.2, h: 0.035, category: 'EMPLOYEE_ID' },
  { x: 0.1, y: 0.37, w: 0.42, h: 0.035, category: 'MEDICAL' },
  { x: 0.1, y: 0.58, w: 0.26, h: 0.035, category: 'PERSON' },
  { x: 0.48, y: 0.78, w: 0.32, h: 0.035, category: 'PHONE' },
]

/**
 * Same inputs and output as the real readText() (ocr.ts). Reads the words on one page image, on this device.
 * `onProgress` gets 0..1. Throws UnreadableScanError when there is no usable text.
 */
export async function readText(
  image: HTMLCanvasElement,
  options: { onProgress?: (progress: OcrProgress) => void } = {},
): Promise<OcrResult> {
  if (image.width < 200 || image.height < 200) throw new UnreadableScanError()

  // A small copy is plenty to tell a dark or blank shot from a page of text.
  const sample = blankCanvas(64, 64)
  context(sample).drawImage(image, 0, 0, 64, 64)
  const looks = brightness(context(sample).getImageData(0, 0, 64, 64).data)

  for (const fraction of [0.15, 0.35, 0.55, 0.75, 0.9, 1]) {
    await wait(180)
    options.onProgress?.({ stage: 'reading', fraction })
  }
  if (tooDarkOrFlat(looks)) throw new UnreadableScanError()

  const words: OcrWord[] = FAKE_WORDS.map((word, index) => ({
    text: `word${index + 1}`,
    x: Math.round(word.x * image.width),
    y: Math.round(word.y * image.height),
    w: Math.round(word.w * image.width),
    h: Math.round(word.h * image.height),
    line: index,
    confidence: 90,
  }))
  return { text: words.map((word) => word.text).join(' '), words }
}

/**
 * Same inputs and output as the real blackOut() (blackout.ts): finds the private details among the words, and
 * returns a copy of the page with each one painted solid black. The boxes say only what kind of detail was there.
 */
export async function blackOut(image: HTMLCanvasElement, ocr: OcrResult): Promise<{ boxes: ScanBox[]; redacted: HTMLCanvasElement }> {
  await wait(250)
  const pad = Math.max(2, Math.round(image.width * 0.004))
  const boxes: ScanBox[] = ocr.words.map((word, index) => ({
    x: word.x - pad,
    y: word.y - pad,
    width: word.w + pad * 2,
    height: word.h + pad * 2,
    category: FAKE_WORDS[index % FAKE_WORDS.length]?.category ?? 'OTHER_ID',
  }))

  const redacted = blankCanvas(image.width, image.height)
  const ctx = context(redacted)
  ctx.drawImage(image, 0, 0)
  ctx.fillStyle = '#000'
  for (const box of boxes) ctx.fillRect(box.x, box.y, box.width, box.height)
  return { boxes, redacted }
}

/**
 * Same inputs and output as the real pdfToPages() (pdf.ts): one picture per PDF page, drawn on this device.
 * The fake can't open PDFs, so it draws three plain made-up pages whatever the file holds.
 */
export async function pdfToPages(file: File, onProgress?: (fraction: number) => void): Promise<HTMLCanvasElement[]> {
  void file
  const pages: HTMLCanvasElement[] = []
  for (let n = 0; n < 3; n++) {
    await wait(200)
    const page = blankCanvas(1240, 1754) // A4 at 150 dpi
    const ctx = context(page)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, page.width, page.height)
    ctx.fillStyle = '#c9c3bb'
    for (let line = 0; line < 22; line++) {
      const y = 140 + line * 70
      ctx.fillRect(124, y, line % 4 === 3 ? 600 : 990, 18)
    }
    // Dark "words" where the fake reader will find them, so the boxes cover something.
    ctx.fillStyle = '#3a3a3a'
    for (const word of FAKE_WORDS) {
      ctx.fillRect(word.x * page.width, word.y * page.height, word.w * page.width, word.h * page.height)
    }
    pages.push(page)
    onProgress?.((n + 1) / 3)
  }
  return pages
}

/**
 * Same inputs and output as the real pagesToPdf() (pdf.ts): one PDF with each blacked-out page as a picture, so no
 * hidden text survives underneath. This fake writes a real, minimal PDF (JPEG pages), so the download works.
 */
export async function pagesToPdf(pages: HTMLCanvasElement[]): Promise<Blob> {
  const jpegs = await Promise.all(
    pages.map(
      (page) =>
        new Promise<Uint8Array>((resolve, reject) =>
          page.toBlob(
            (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('No image'))),
            'image/jpeg',
            0.9,
          ),
        ),
    ),
  )
  return new Blob([jpegPdf(jpegs.map((jpeg, i) => ({ jpeg, width: pages[i]?.width ?? 1, height: pages[i]?.height ?? 1 })))], {
    type: 'application/pdf',
  })
}

/** A minimal PDF with one full-page JPEG per page, sized at 150 dpi. */
function jpegPdf(pages: ReadonlyArray<{ jpeg: Uint8Array; width: number; height: number }>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length
    push(`${id} 0 obj\n${body}\n`)
    if (stream) {
      push('stream\n')
      push(stream)
      push('\nendstream\n')
    }
    push('endobj\n')
  }

  push('%PDF-1.4\n')
  const pageIds = pages.map((_, i) => 3 + i * 3)
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  pages.forEach((page, i) => {
    const [pageId, imageId, contentId] = [3 + i * 3, 4 + i * 3, 5 + i * 3]
    const w = Math.round((page.width * 72) / 150)
    const h = Math.round((page.height * 72) / 150)
    const content = encoder.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`)
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    )
    object(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>`,
      page.jpeg,
    )
    object(contentId, `<< /Length ${content.length} >>`, content)
  })

  const count = 3 + pages.length * 3
  const xref = length
  push(`xref\n0 ${count}\n0000000000 65535 f \n`)
  for (let id = 1; id < count; id++) push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
