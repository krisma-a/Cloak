// The redacted-PDF writer: one PDF made only from the blacked-out page pictures (no text layer, so nothing hidden survives
// underneath), written here with no outside library. Opening PDFs is src/camera/pdf.ts. Nothing is sent anywhere.

/**
 * One PDF with each blacked-out page as a picture (JPEG), so no hidden text survives underneath. A real, minimal PDF.
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
