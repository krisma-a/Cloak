// A small PDF writer for plain text, written for Cloak: the finished draft as a PDF, made on this laptop with no outside
// library. US Letter pages, the standard Helvetica font (every PDF viewer has it, so nothing is embedded), words wrapped
// to the page, page breaks as needed. Pure (no DOM), so tests run in Node.
//
// Text outside Latin-1 and the common Windows-1252 punctuation (curly quotes, dashes, bullets, …) is shown as "?", the
// price of using a built-in font. The draft text is the person's own; it is never sent anywhere by this file.

const PAGE = { width: 612, height: 792, margin: 72 }
const BODY = { size: 11, leading: 15 }
const TITLE = { size: 16, leading: 22 }

/** Helvetica advance widths (per 1000 em) for ASCII 32–126, from the standard font metrics. */
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]

/** Windows-1252 bytes for the punctuation that isn't in Latin-1, with their widths. */
const CP1252: Record<string, [number, number]> = {
  '€': [0x80, 556], '‚': [0x82, 222], 'ƒ': [0x83, 556], '„': [0x84, 333], '…': [0x85, 1000], '†': [0x86, 556], '‡': [0x87, 556],
  'ˆ': [0x88, 333], '‰': [0x89, 1000], 'Š': [0x8a, 667], '‹': [0x8b, 333], 'Œ': [0x8c, 1000], 'Ž': [0x8e, 611], '‘': [0x91, 222],
  '’': [0x92, 222], '“': [0x93, 333], '”': [0x94, 333], '•': [0x95, 350], '–': [0x96, 556], '—': [0x97, 1000], '˜': [0x98, 333],
  '™': [0x99, 1000], 'š': [0x9a, 500], '›': [0x9b, 333], 'œ': [0x9c, 944], 'ž': [0x9e, 500], 'Ÿ': [0x9f, 667],
}

/** The byte (Windows-1252) and width for one character; "?" for anything the font can't show. */
function glyph(ch: string): [number, number] {
  const code = ch.codePointAt(0) ?? 63
  if (code >= 32 && code <= 126) return [code, WIDTHS[code - 32] as number]
  if (code >= 0xa0 && code <= 0xff) return [code, 556]
  const mapped = CP1252[ch]
  if (mapped) return mapped
  if (code === 9) return [32, 278] // a tab is a space
  return [63, 556]
}

function widthOf(text: string, size: number): number {
  let total = 0
  for (const ch of text) total += glyph(ch)[1]
  return (total * size) / 1000
}

/** Breaks `text` into lines no wider than `maxWidth` points. Paragraph breaks and blank lines are kept. */
export function wrapLines(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let piece = word
      // A single word wider than the page is cut into pieces that fit.
      while (widthOf(piece, size) > maxWidth) {
        let cut = piece.length
        while (cut > 1 && widthOf(piece.slice(0, cut), size) > maxWidth) cut--
        if (line) {
          lines.push(line)
          line = ''
        }
        lines.push(piece.slice(0, cut))
        piece = piece.slice(cut)
      }
      const next = line ? `${line} ${piece}` : piece
      if (line && widthOf(next, size) > maxWidth) {
        lines.push(line)
        line = piece
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  return lines
}

/** A PDF string: bytes in parentheses, with \ ( ) and non-ASCII escaped as octal. */
function pdfString(text: string): string {
  let out = ''
  for (const ch of text) {
    const [byte] = glyph(ch)
    out += byte === 0x28 || byte === 0x29 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : byte < 32 || byte > 126 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)
  }
  return `(${out})`
}

/** A PDF of `text` (with an optional bold-looking title line first), as bytes. */
export function textToPdf(text: string, title?: string): Uint8Array<ArrayBuffer> {
  const usable = PAGE.width - PAGE.margin * 2
  type Row = { text: string; size: number; leading: number }
  const rows: Row[] = []
  if (title) {
    for (const line of wrapLines(title, TITLE.size, usable)) rows.push({ text: line, ...TITLE })
    rows.push({ text: '', ...BODY })
  }
  for (const line of wrapLines(text, BODY.size, usable)) rows.push({ text: line, ...BODY })

  // Lay the rows out on pages from the top margin down.
  const pages: Row[][] = [[]]
  let y = PAGE.height - PAGE.margin
  for (const row of rows) {
    if (y - row.leading < PAGE.margin) {
      pages.push([])
      y = PAGE.height - PAGE.margin
    }
    ;(pages[pages.length - 1] as Row[]).push(row)
    y -= row.leading
  }

  const streams = pages.map((page) => {
    let content = 'BT\n'
    let at = PAGE.height - PAGE.margin
    let first = true
    for (const row of page) {
      content += `/F1 ${row.size} Tf\n${row.leading} TL\n`
      if (first) {
        content += `${PAGE.margin} ${at - row.size} Td\n`
        first = false
      } else {
        content += 'T*\n'
      }
      if (row.text) content += `${pdfString(row.text)} Tj\n`
      at -= row.leading
    }
    return `${content}ET`
  })

  // Objects: 1 catalog, 2 page tree, 3 font, then per page a page object and its content stream.
  const objects: string[] = []
  const pageIds = pages.map((_, i) => 4 + i * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  streams.forEach((stream, i) => {
    const pageId = 4 + i * 2
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  const infoId = objects.length
  objects[infoId] = '<< /Producer (Cloak) /Title (Cloak draft) >>'

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  // Every character in `body` is one byte (the strings are escaped to ASCII), so the offsets above are byte offsets.
  const bytes = new Uint8Array(body.length)
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff
  return bytes
}

/** The page size, for tests. */
export const PDF_PAGE = PAGE
