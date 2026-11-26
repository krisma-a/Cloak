// The ONLY file you change to connect the real scanning code.
// The "Scan a document" screen (StepScan.tsx) imports OCR, blackout and PDF functions from here, and nothing else.
//
// Reading and blacking out are REAL and run on this device: readText() is src/camera/ocr.ts, blackOut() is
// src/camera/blackout.ts with the same on-device redaction as the paste screen (redactNotes() in ai.ts, so the
// "Basic checks only" choice applies here too). Nothing is sent anywhere: not the picture, not the text.
//
// The PDF functions are still the placeholders from fakeScan.ts (src/camera/pdf.ts doesn't exist yet):
//
//   pdfToPages(file, onProgress?) -> Promise<HTMLCanvasElement[]>                       src/camera/pdf.ts
//     One picture per page, on this device. Throw if the file can't be opened.
//
//   pagesToPdf(pages) -> Promise<Blob>                                                  src/camera/pdf.ts
//     One PDF made only from the blacked-out pictures (no text layer), so nothing hidden survives underneath.
//
// TO CONNECT THE REAL PDF CODE: replace the fakeScan.ts line below with
//    export { pdfToPages, pagesToPdf } from '../camera/pdf.ts'
// and set PDF_DEMO to false.

import { redactNotes } from './ai.ts'
import { loadCheckMode } from './checkMode.ts'
import type { LiveView, OcrProgress, OcrResult, Rect, ScanBox } from './scan.ts'

export { pagesToPdf, pdfToPages } from './fakeScan.ts'

/** Whether Cloak's private AI (Gemini Nano) can run in this browser. Downloads nothing. */
export { privateAiSupported } from './ai.ts'

/** True while the PDF functions are the placeholders (made-up pages, whatever the file holds). The result screen says so. */
export const PDF_DEMO = true

/**
 * One page, blacked out. "blocked": a detail couldn't be hidden or placed, so there is no copy and the page can't be
 * downloaded. An "ok" page can still be `unclear`: too much of it was read badly, so details may have been missed.
 */
export type ScanPageResult =
  | {
      status: 'ok'
      boxes: ScanBox[]
      redacted: HTMLCanvasElement
      /** Words read with low confidence, to check by eye. Positions only. */
      review: Rect[]
      /** Low-confidence words, a whole-line box, or the basic engine: the person should check this page. */
      needsReview: boolean
      /** More than 15% of the words were read badly: details may have been missed, so this copy is risky to use. */
      unclear: boolean
    }
  | { status: 'blocked' }

// Tesseract.js and the redaction code are large, so they load on first use, not with the first screen.

/** Reads one page on this device: the text and every word with its box, in the image's own pixels. */
export async function readText(image: HTMLCanvasElement, options?: { onProgress?: (progress: OcrProgress) => void }): Promise<OcrResult> {
  const ocr = await import('../camera/ocr.ts')
  return ocr.readText(image, options)
}

/** Finds the private details in `ocr` on this device and paints each one solid black on a COPY of `image`. */
export async function blackOut(image: HTMLCanvasElement, ocr: OcrResult): Promise<ScanPageResult> {
  const { blackOut: run } = await import('../camera/blackout.ts')
  const result = await run(image, ocr, {
    redact: (text) => redactNotes(text, undefined, { basicOnly: loadCheckMode() === 'basic' }),
  })
  if (result.status !== 'ok') return { status: 'blocked' }
  if (!(result.canvas instanceof HTMLCanvasElement)) throw new Error('The blacked-out copy isn’t a page canvas.')
  return {
    status: 'ok',
    boxes: result.boxes.map(({ x, y, width, height, category }) => ({ x, y, width, height, category })),
    redacted: result.canvas,
    review: result.review,
    needsReview: result.needsReview,
    unclear: result.unclear,
  }
}

// ---------------------------------------------------------------------------------------------
// Live camera preview: every line of text is blurred while aiming (only the text reader runs, so it's quick, and
// nothing private can show or be missed). A preview only: the photo gets the full check from blackOut(), and then
// only the private details stay hidden. Frames and their text stay in this tab's memory, never stored.

/**
 * Loads the text reader as soon as the camera view opens, and the in-browser name model alongside it, so both the
 * live blur and the photo's check start sooner. Best effort.
 */
export async function warmUpPreview(): Promise<void> {
  const [ocr, redact] = await Promise.all([import('../camera/ocr.ts'), import('../ai/redact.ts')])
  await Promise.all([ocr.prepareOcr(), redact.prepareRedaction(undefined, 'browser-model')])
}

/** Where to blur one video frame: a padded box over each line of real text, or "no-text" when there is none. */
export async function previewLines(frame: HTMLCanvasElement, ocr: OcrResult): Promise<LiveView> {
  if (ocr.words.length === 0) return { kind: 'no-text' }
  const { textLines, unclearWords, DEFAULT_MAX_UNCLEAR_SHARE } = await import('../camera/blackoutPlan.ts')
  const lines = textLines(ocr, frame)
  // Only junk "words" (a face, a wall): no page in view, so nothing to blur.
  if (lines.length === 0) return { kind: 'no-text' }
  return {
    kind: 'text',
    lines,
    width: frame.width,
    height: frame.height,
    unclear: unclearWords(ocr.words).share > DEFAULT_MAX_UNCLEAR_SHARE,
  }
}
