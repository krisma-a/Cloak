// The files the OCR engine (Tesseract.js) needs in the browser. Cloak serves them itself, under <base>ocr/,
// so the engine never loads code or data from a CDN: `npm run dev` serves them straight from node_modules and
// `npm run build` copies them into dist/ocr/ (the plugin in scripts/viteOcrAssets.ts). Pure, so ocr.ts, the
// Vite config and the tests can all read it.
//
// The names are fixed because Tesseract.js builds the engine and language file names itself. It picks one of the
// three engine builds from what the browser's WebAssembly supports; "lstm" is the only recogniser Cloak uses,
// which keeps each build smaller.

export const OCR_DIR = 'ocr'

/** Which English data: the integer "best" LSTM model, the one Tesseract.js uses by default. */
export const ENG_DATA_VERSION = '4.0.0_best_int'

export interface OcrFile {
  /** Where it is served, inside OCR_DIR. */
  path: string
  /** Where it comes from, as a package path that resolves from the tesseract.js package. */
  from: string
}

export const OCR_FILES: readonly OcrFile[] = [
  { path: 'worker.min.js', from: 'tesseract.js/dist/worker.min.js' },
  { path: 'core/tesseract-core-relaxedsimd-lstm.wasm.js', from: 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js' },
  { path: 'core/tesseract-core-simd-lstm.wasm.js', from: 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js' },
  { path: 'core/tesseract-core-lstm.wasm.js', from: 'tesseract.js-core/tesseract-core-lstm.wasm.js' },
  { path: 'lang/eng.traineddata.gz', from: `@tesseract.js-data/eng/${ENG_DATA_VERSION}/eng.traineddata.gz` },
]
