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
// Live camera preview. Two quick looks per frame, so the blur appears fast:
//   1. quickPreview(): rules only (phone, email, IDs, dates of birth...: under a millisecond) plus names remembered from
//      the last few seconds, right after the text is read.
//   2. previewBoxes(): the in-browser name model as well (a few hundred ms), which also refreshes the remembered names.
// Never Gemini Nano (too slow per frame, and it may only start downloading after a click). A preview only: the photo
// gets the full check from blackOut(). Frames, text and remembered names stay in this tab's memory, never stored.

type LiveRedaction = Awaited<ReturnType<typeof redactNotes>>

/** Hidden strings seen in recent frames ("riley sample" -> "[EMPLOYEE_1]"), with when they were last seen. */
const remembered = new Map<string, { placeholder: string; seenAt: number }>()
const REMEMBER_MS = 15_000

function rememberedNow(): Record<string, string> {
  const now = Date.now()
  for (const [hidden, entry] of remembered) if (now - entry.seenAt > REMEMBER_MS) remembered.delete(hidden)
  return Object.fromEntries([...remembered].map(([hidden, entry]) => [hidden, entry.placeholder]))
}

/** Forgets the remembered names. Call when the camera view closes. */
export function forgetPreview(): void {
  remembered.clear()
}

/** Loads the text reader and the in-browser name model together, as soon as the camera view opens. Best effort. */
export async function warmUpPreview(): Promise<void> {
  const [ocr, redact] = await Promise.all([import('../camera/ocr.ts'), import('../ai/redact.ts')])
  await Promise.all([ocr.prepareOcr(), redact.prepareRedaction(undefined, 'browser-model')])
}

async function livePreview(frame: HTMLCanvasElement, ocr: OcrResult, find: (text: string) => Promise<LiveRedaction>): Promise<LiveView> {
  if (ocr.words.length === 0) return { kind: 'no-text' }
  const { detectBoxes, rememberedInText } = await import('../camera/blackoutPlan.ts')
  const result = await detectBoxes(ocr, frame, async (text) => {
    const found = await find(text)
    const now = Date.now()
    for (const [hidden, placeholder] of Object.entries(found.map.lookup)) remembered.set(hidden, { placeholder, seenAt: now })
    // Names seen in earlier frames but missed in this one are blurred too, if they are on this frame.
    const lookup = { ...rememberedInText(rememberedNow(), text), ...found.map.lookup }
    return { ...found, map: { ...found.map, lookup } }
  })
  if (result.status !== 'ok') return { kind: result.status }
  return {
    kind: 'found',
    boxes: result.boxes.map(({ x, y, width, height, category }) => ({ x, y, width, height, category })),
    width: frame.width,
    height: frame.height,
  }
}

/** First look at a frame: rules and remembered names only, so details blur right after the text is read. */
export async function quickPreview(frame: HTMLCanvasElement, ocr: OcrResult): Promise<LiveView> {
  const { redact } = await import('../ai/redact.ts')
  return livePreview(frame, ocr, (text) => redact(text, { engine: 'rules-only' }))
}

/** Second look at the same frame: the in-browser name model too (basic engine). */
export async function previewBoxes(frame: HTMLCanvasElement, ocr: OcrResult): Promise<LiveView> {
  return livePreview(frame, ocr, (text) => redactNotes(text, undefined, { basicOnly: true }))
}
