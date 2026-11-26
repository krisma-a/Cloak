import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { PDF_WASM, pdfUrls } from './pdfAssets.ts'

test('the PDF reader loads only from Cloak’s own paths', () => {
  const urls = pdfUrls('/')
  assert.equal(urls.worker, '/pdf/pdf.worker.min.mjs')
  assert.ok([urls.fonts, urls.wasm].every((u) => u.startsWith('/pdf/')))
  assert.ok(Object.values(pdfUrls('/app/')).every((u) => u.startsWith('/app/pdf/')))
  for (const url of Object.values(urls)) assert.ok(!/^https?:/.test(url), url)
})

test('every file Cloak serves for the PDF reader exists in the installed package', () => {
  const root = join(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'), '..')
  assert.ok(existsSync(join(root, 'build', 'pdf.worker.min.mjs')))
  assert.ok(existsSync(join(root, 'standard_fonts', 'LiberationSans-Regular.ttf')))
  for (const name of PDF_WASM) assert.ok(existsSync(join(root, 'wasm', name)), name)
})
