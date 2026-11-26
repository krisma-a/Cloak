import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDF_PAGE, textToPdf, wrapLines } from './textPdf.ts'

const asText = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

test('wrapLines keeps paragraphs and blank lines, and never makes a line wider than the page', () => {
  const lines = wrapLines('One short line.\n\nA much longer line '.concat('word '.repeat(60)), 11, 468)
  assert.equal(lines[0], 'One short line.')
  assert.equal(lines[1], '')
  assert.ok(lines.length > 4)
  assert.ok(lines.slice(2).every((line) => line.length > 0))
  // A word wider than the page is cut into pieces.
  const cut = wrapLines('x'.repeat(400), 11, 468)
  assert.ok(cut.length > 1 && cut.every((l) => l.length < 400))
})

test('a short draft is one valid PDF page: header, objects, a correct xref, and the text', () => {
  const bytes = textToPdf('Dear Maria,\nThank you (really) for your time.', 'Investigation summary')
  const text = asText(bytes)
  assert.ok(text.startsWith('%PDF-1.4\n') && text.trimEnd().endsWith('%%EOF'))
  assert.match(text, /\/Count 1/)
  assert.ok(text.includes('(Dear Maria,) Tj'))
  assert.ok(text.includes('(Thank you \\(really\\) for your time.) Tj'), 'parentheses are escaped')
  assert.ok(text.includes('(Investigation summary) Tj'))
  // Every xref entry points at "N 0 obj".
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1])
  assert.equal(text.slice(xrefAt, xrefAt + 4), 'xref')
  const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]))
  entries.forEach((offset, i) => assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`))
})

test('a long draft flows onto more pages, and every page has its own content', () => {
  const long = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of the draft.`).join('\n')
  const text = asText(textToPdf(long))
  const pages = Number(/\/Count (\d+)/.exec(text)?.[1])
  assert.ok(pages >= 4, `pages: ${pages}`)
  assert.equal([...text.matchAll(/\/Type \/Page /g)].length, pages)
  assert.ok(text.includes('(Line 200 of the draft.) Tj'))
  assert.equal(PDF_PAGE.width, 612)
})

test('curly quotes and dashes survive as Windows-1252 bytes; unsupported characters become "?"', () => {
  const text = asText(textToPdf('“Quoted” — it’s fine • 日本'))
  assert.ok(text.includes('\\223Quoted\\224 \\227 it\\222s fine \\225 ??'), text.slice(text.indexOf('BT'), text.indexOf('ET')))
})
