// The ONLY file you change to connect the real scanning code.
// The "Scan a document" screen (StepScan.tsx) imports OCR, blackout and PDF functions from here, and nothing else.
//
// Reading and blacking out are REAL and run on this device: readText() is src/camera/ocr.ts, blackOut() is
// src/camera/blackout.ts with the same on-device redaction as the paste screen (redactNotes() in ai.ts, so the
// "Basic checks only" choice applies here too). Nothing is sent anywhere: not the picture, not the text.
//
// PDFs: pdfToPages() (src/camera/pdf.ts, pdf.js with its files served from Cloak) draws each page to a picture, which goes
// through the same reading and blackout as a photo; pagesToPdf() (redactedPdf.ts) makes the
// redacted PDF from the blacked-out pictures only, so no hidden text survives underneath.

import { redactNotes } from './ai.ts'
import { loadCheckMode } from './checkMode.ts'
import type { LiveView, OcrProgress, OcrResult, Rect, ScanBlockReason, ScanBox } from './scan.ts'

export { pagesToPdf } from './redactedPdf.ts'

/** One picture per page of a PDF, on this laptop (pdf.js, loaded on first use). Throws PdfScanError if it can't be opened. */
export async function pdfToPages(file: File, onProgress?: (fraction: number) => void): Promise<HTMLCanvasElement[]> {
  const { pdfToPages: read } = await import('../camera/pdf.ts')
  return read(file, onProgress)
}

/** Whether Cloak's private AI (Gemini Nano) can run in this browser. Downloads nothing. */
export { privateAiSupported } from './ai.ts'

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
      /** The copy was read again after blackout: how many missed details that covered (0 = it was already clean). */
      rechecked: { fixed: number }
    }
  | { status: 'blocked'; reason: ScanBlockReason }

// Tesseract.js and the redaction code are large, so they load on first use, not with the first screen.

// People found on earlier pages of this scan, so page 3's "Signed: Hernandez" is hidden even when only page 1 says
// "Luis Hernandez". In this tab's memory only, never stored; cleared by startScan().
const caseNames = new Set<string>()

/** Starts a new scan: forgets the names found on the last one. Call before reading the first page. */
export function startScan(): void {
  caseNames.clear()
}

/** Reads one page on this device: the text and every word with its box, in the image's own pixels. */
export async function readText(image: HTMLCanvasElement, options?: { onProgress?: (progress: OcrProgress) => void }): Promise<OcrResult> {
  const ocr = await import('../camera/ocr.ts')
  return ocr.readText(image, options)
}

/**
 * Finds the private details in `ocr` on this device and paints each one solid black on a COPY of `image`, then reads
 * that copy again and covers any hidden detail that still shows (src/camera/recheck.ts). Still showing after 2 rounds
 * of fixes: blocked. `onRecheck` is called when the second read starts.
 */
export async function blackOut(image: HTMLCanvasElement, ocr: OcrResult, onRecheck?: () => void): Promise<ScanPageResult> {
  const { blackOut: run } = await import('../camera/blackout.ts')
  const result = await run(image, ocr, {
    redact: async (text) => {
      const result = await redactNotes(text, undefined, { basicOnly: loadCheckMode() === 'basic', knownNames: [...caseNames] })
      for (const [placeholder, original] of Object.entries(result.map.originals)) {
        if (placeholder.startsWith('[EMPLOYEE_')) caseNames.add(original)
      }
      return result
    },
    reread: (canvas) => readText(canvas as HTMLCanvasElement),
    onRecheck,
  })
  if (result.status !== 'ok') {
    // Counts only, never text: enough to tell which safety check stopped the page.
    console.info('Cloak scan: no copy made', { reason: result.reason, count: result.count, engine: result.engine })
    return { status: 'blocked', reason: result.reason }
  }
  if (!(result.canvas instanceof HTMLCanvasElement)) throw new Error('The blacked-out copy isn’t a page canvas.')
  return {
    status: 'ok',
    boxes: result.boxes.map(({ x, y, width, height, category }) => ({ x, y, width, height, category })),
    redacted: result.canvas,
    review: result.review,
    needsReview: result.needsReview,
    unclear: result.unclear,
    rechecked: { fixed: result.recheck?.fixed ?? 0 },
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
