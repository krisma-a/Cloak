// Where Cloak serves the PDF reader's own files from (pdf.js), so it never loads code or data from a CDN. Pure, so
// pdf.ts, the Vite plugin (scripts/vitePdfAssets.ts) and the tests can all read it.

export const PDF_DIR = 'pdf'

/** The image decoders scanned PDFs may need: JBIG2 (black-and-white scans), JPEG 2000, and colour profiles. */
export const PDF_WASM: readonly string[] = ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm']

/** Cloak's files for the PDF reader, as URLs under `base` (the site's base path, ending in "/"). */
export function pdfUrls(base: string): { worker: string; fonts: string; wasm: string } {
  return {
    worker: `${base}${PDF_DIR}/pdf.worker.min.mjs`,
    fonts: `${base}${PDF_DIR}/standard_fonts/`,
    wasm: `${base}${PDF_DIR}/wasm/`,
  }
}
