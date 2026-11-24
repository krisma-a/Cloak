import { createReadStream, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'
import { OCR_DIR, OCR_FILES } from '../src/camera/ocrAssets.ts'

/**
 * Serves the OCR engine's files (see src/camera/ocrAssets.ts) from Cloak itself instead of a CDN: in dev straight
 * from node_modules, and in the build as fixed-name files in dist/ocr/.
 */
export function ocrAssets(): Plugin {
  // Resolve from tesseract.js's own folder, so its tesseract.js-core dependency is found wherever npm put it.
  const fromTesseract = createRequire(createRequire(import.meta.url).resolve('tesseract.js/package.json'))
  const files = new Map(OCR_FILES.map(({ path, from }) => [path, fromTesseract.resolve(from)]))

  return {
    name: 'cloak-ocr-assets',

    configureServer(server) {
      server.middlewares.use(`${server.config.base}${OCR_DIR}/`, (req, res, next) => {
        const file = files.get((req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '')
        if (!file) return next()
        // The .gz language file goes out as plain bytes (no Content-Encoding): Tesseract.js unzips it itself.
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },

    generateBundle() {
      for (const [path, file] of files) {
        this.emitFile({ type: 'asset', fileName: `${OCR_DIR}/${path}`, source: readFileSync(file) })
      }
    },
  }
}
