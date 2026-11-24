// The ONLY file you change to connect the real scanning code.
// The "Scan a document" screen (StepScan.tsx) imports OCR, blackout and PDF functions from here, and nothing else.
//
// Today every function is the placeholder from fakeScan.ts. Everything runs on this device and nothing is sent.
//
// The four functions and what the real ones must do:
//
//   readText(image, { onProgress? }) -> Promise<OcrResult>                              src/camera/ocr.ts
//     Already real: src/camera/ocr.ts. Reads one page (a canvas) and returns the text and every word with its box,
//     in the image's own pixels. `onProgress` gets { stage: 'loading' | 'reading', fraction }. A page with no words,
//     or a read that throws, is shown as "We couldn't read this. Try more light and hold it steady."
//
//   blackOut(image, ocr) -> Promise<{ boxes: ScanBox[]; redacted: HTMLCanvasElement }>  src/camera/blackout.ts
//     Find the private details in `ocr` (on this device), paint each one solid black on a COPY of `image`, and
//     return the copy plus one box per black area with its category. The boxes must never carry the hidden text.
//
//   pdfToPages(file, onProgress?) -> Promise<HTMLCanvasElement[]>                       src/camera/pdf.ts
//     One picture per page, on this device. Throw if the file can't be opened.
//
//   pagesToPdf(pages) -> Promise<Blob>                                                  src/camera/pdf.ts
//     One PDF made only from the blacked-out pictures (no text layer), so nothing hidden survives underneath.

export { blackOut, pagesToPdf, pdfToPages, readText } from './fakeScan.ts'

/** True while the functions above are the placeholders. The result screen says so. Set to false when connected. */
export const SCAN_DEMO = true

// ---------------------------------------------------------------------------------------------
// TO CONNECT THE REAL CODE:
//
// 1. Delete the `export { ... } from './fakeScan.ts'` line above.
// 2. Paste this in its place (rename to match what the files really export):
//
//    export { readText } from '../camera/ocr.ts'   // already built; works on its own
//    export { blackOut } from '../camera/blackout.ts'
//    export { pdfToPages, pagesToPdf } from '../camera/pdf.ts'
//
// 3. Set SCAN_DEMO to false.
//
// Tesseract.js and a PDF reader are large, so consider loading them on first use (as ai.ts does for redaction)
// instead of with the first screen.
// ---------------------------------------------------------------------------------------------
