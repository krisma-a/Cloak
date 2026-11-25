// PLACEHOLDER PDF FUNCTIONS, until src/camera/pdf.ts exists. Nothing is sent anywhere.
//
// Same inputs and output as the real ones will have (see scanAi.ts). pdfToPages() ignores the file and draws three
// made-up pages of readable text, so the real reader and blackout run on them; pagesToPdf() writes a real PDF.

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

// Made-up note lines for the fake PDF pages. FAKE DATA ONLY: no real person, ID or case.
const FAKE_PAGES: ReadonlyArray<readonly string[]> = [
  [
    'Case notes - page 1',
    'Met with Jordan Example (ID E-1042) on Oct 3.',
    'Jordan asked for a quieter desk near the window.',
    'Manager Riley Sample agreed to review the seating plan.',
    'Follow up by phone on 555-010-0199 next week.',
  ],
  [
    'Case notes - page 2',
    'Riley Sample confirmed the desk move for Oct 10.',
    'No other changes were requested.',
  ],
  ['Case notes - page 3', 'Closed. Email jordan.example@example.com the summary.'],
]

/**
 * Same inputs and output as the real pdfToPages() (pdf.ts): one picture per PDF page, drawn on this device.
 * The fake can't open PDFs, so it draws three plain made-up pages whatever the file holds.
 */
export async function pdfToPages(file: File, onProgress?: (fraction: number) => void): Promise<HTMLCanvasElement[]> {
  void file
  const pages: HTMLCanvasElement[] = []
  for (const [n, lines] of FAKE_PAGES.entries()) {
    await wait(200)
    const page = blankCanvas(1240, 1754) // A4 at 150 dpi
    const ctx = context(page)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, page.width, page.height)
    // Real, readable made-up text, so the real reader and blackout have something to work on.
    ctx.fillStyle = '#111'
    ctx.font = '36px Helvetica, Arial, sans-serif'
    lines.forEach((line, index) => ctx.fillText(line, 124, 180 + index * 80))
    pages.push(page)
    onProgress?.((n + 1) / FAKE_PAGES.length)
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
