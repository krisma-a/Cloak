// Reads a PDF on this laptop: each page is drawn to a picture, which then goes through the same OCR and blackout as a
// photo. Uses pdf.js (Mozilla, Apache-2.0) with its worker, fonts and image decoders served from Cloak's own files
// (pdfAssets.ts), so nothing is loaded from, or sent to, any other site. The file never leaves this laptop.
//
// Hardened for files from people you don't control: this uses only the page-drawing part of pdf.js. PDF scripts and forms
// aren't run (pdf.js 6 has no scripting or eval options on the reader; that code lives only in its separate viewer, which
// Cloak doesn't use), and its sandbox and renderer builds aren't served.

import { PdfScanError, PDF_LONG_SIDE, PDF_MAX_PAGES, pdfScale } from '../workspace/scan.ts'
import { pdfUrls } from './pdfAssets.ts'

type PdfJs = typeof import('pdfjs-dist')

let library: Promise<PdfJs> | undefined

/** pdf.js, loaded on first use (it's large), with its worker pointed at Cloak's own copy. */
function loadPdfJs(): Promise<PdfJs> {
  library ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfUrls(import.meta.env.BASE_URL ?? '/').worker
    return pdfjs
  })
  return library
}

/** One picture per page of `file`, drawn at about 150 dpi on white. Throws PdfScanError when it can't be opened. */
export async function pdfToPages(file: File, onProgress?: (fraction: number) => void): Promise<HTMLCanvasElement[]> {
  const pdfjs = await loadPdfJs()
  const urls = pdfUrls(import.meta.env.BASE_URL ?? '/')
  const data = new Uint8Array(await file.arrayBuffer())

  const task = pdfjs.getDocument({ data, standardFontDataUrl: urls.fonts, wasmUrl: urls.wasm, useSystemFonts: false })
  let document
  try {
    document = await task.promise
  } catch (error) {
    await task.destroy().catch(() => undefined)
    const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
    throw new PdfScanError(name === 'PasswordException' ? 'password' : 'damaged')
  }

  try {
    if (document.numPages > PDF_MAX_PAGES) throw new PdfScanError('too-many-pages', document.numPages)
    const pages: HTMLCanvasElement[] = []
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: pdfScale(base.width, base.height, PDF_LONG_SIDE) })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new PdfScanError('damaged')
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height) // pdf.js draws on transparent; a page is white paper
      await page.render({ canvas, canvasContext: context, viewport }).promise
      page.cleanup()
      pages.push(canvas)
      onProgress?.(number / document.numPages)
    }
    return pages
  } catch (error) {
    if (error instanceof PdfScanError) throw error
    throw new PdfScanError('damaged')
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
