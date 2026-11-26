import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { PDF_DIR, PDF_WASM } from '../src/camera/pdfAssets.ts'

/**
 * Serves the PDF reader's files (pdf.js, see src/camera/pdfAssets.ts) from Cloak itself instead of a CDN: in dev straight
 * from node_modules, and in the build as fixed-name files in dist/pdf/. The worker, the standard fonts used for PDFs
 * that don't embed theirs, and the image decoders (JBIG2, JPEG 2000, colour profiles) that scanned PDFs use.
 */
export function pdfAssets(): Plugin {
  const root = join(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'), '..')
  const files = new Map<string, string>()
  files.set('pdf.worker.min.mjs', join(root, 'build', 'pdf.worker.min.mjs'))
  for (const name of readdirSync(join(root, 'standard_fonts'))) {
    if (/\.(pfb|ttf)$/.test(name)) files.set(`standard_fonts/${name}`, join(root, 'standard_fonts', name))
  }
  for (const name of PDF_WASM) files.set(`wasm/${name}`, join(root, 'wasm', name))

  const type = (file: string) => (/\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')

  return {
    name: 'cloak-pdf-assets',

    configureServer(server) {
      server.middlewares.use(`${server.config.base}${PDF_DIR}/`, (req, res, next) => {
        const file = files.get((req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '')
        if (!file) return next()
        res.setHeader('Content-Type', type(file))
        createReadStream(file).pipe(res)
      })
    },

    generateBundle() {
      for (const [path, file] of files) {
        this.emitFile({ type: 'asset', fileName: `${PDF_DIR}/${path}`, source: readFileSync(file) })
      }
    },
  }
}
