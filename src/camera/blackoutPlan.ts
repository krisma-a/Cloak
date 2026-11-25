// Where to paint the black boxes on a scanned page, and the whole blackout flow with its parts passed in.
// Pure (no Firebase, no DOM), so it runs under `node --test`. blackout.ts plugs in the real redact() and canvas.
//
// Fail closed, everywhere:
// - Redaction blocked            -> status "blocked", nothing is painted, no text is returned.
// - Hidden text found in the words (exact, or with OCR look-alikes such as 0/O and 1/l, across line breaks)
//                                -> those words are painted over.
// - Found in the OCR text but not in the words -> its whole line is painted over, and the page needs review.
// - Not found anywhere, or a word box lies outside the image -> "blocked": we can't say where it is.
// - Words read with low confidence (under 60 by default) are flagged for review (their boxes only, never their text).
// - More than 15% of the words read with low confidence -> "blocked" ("hard-to-read"), before redaction even runs:
//   private details hidden in garbled words can't be found, so a copy would look safe and not be.
//
// What may leave the laptop: only `redactedText` (placeholders, no real values). Never the image, never the boxes'
// words: a box carries a category and a position, nothing else.

import type { Category } from '../ai/placeholders.ts'
import type { OcrResult, OcrWord } from './ocr.ts'

/** A rectangle in the image's own pixels. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How a box was placed: "word" (the hidden text lines up with whole words), "partial" (it sits inside a longer
 * word, so the whole word is covered), "line" (found only in the OCR text, so its whole line is covered).
 */
export type BoxSource = 'word' | 'partial' | 'line'

/** One black box. Never holds the hidden text. */
export interface BlackoutBox extends Rect {
  category: Category
  source: BoxSource
}

/** The parts of a redaction result this file reads (RedactionResult in src/ai/redact.ts has them all). */
export interface RedactionLike {
  status: 'ok' | 'blocked'
  redactedText: string
  map: { originals: Record<string, string>; lookup: Record<string, string> }
  leaks: readonly unknown[]
  engine: string
  needsCarefulReview: boolean
}

export interface PlanOptions {
  /** Extra pixels around each box. Default 4. */
  padding?: number
  /** Words below this OCR confidence (0–100) are flagged for review. Default 60. */
  minConfidence?: number
  /** Share of low-confidence words (0–1) above which the page is too hard to read safely. Default 0.15. */
  maxUnclearShare?: number
}

export interface Plan {
  boxes: BlackoutBox[]
  /** Low-confidence words, padded like the boxes. Positions only. */
  review: Rect[]
  /** Hidden strings that could not be placed anywhere (a count is enough: the strings stay here). */
  unplaced: number
  /** Word boxes that are not inside the image (the OCR and the image don't match). */
  outside: number
}

export const DEFAULT_PADDING = 4
export const DEFAULT_MIN_CONFIDENCE = 60
export const DEFAULT_MAX_UNCLEAR_SHARE = 0.15

/** How many words were read with low confidence, and what share of all words that is (1 when there are none). */
export function unclearWords(words: readonly OcrWord[], minConfidence = DEFAULT_MIN_CONFIDENCE): { count: number; share: number } {
  const count = words.filter((word) => word.confidence < minConfidence).length
  return { count, share: words.length === 0 ? 1 : count / words.length }
}

// ---------------------------------------------------------------------------------------------
// Matching text against OCR words

// Characters OCR mixes up, folded to one form on both sides, so "J0rdan" matches "Jordan" and "Ke1ly" matches "Kelly".
const LOOK_ALIKES: Record<string, string> = { '0': 'o', '1': 'l', i: 'l', '|': 'l', '!': 'l', '5': 's' }

/** Lower case, look-alikes folded, everything but letters and digits dropped. "Mar1a-José," -> "marlajosé". */
export function matchKey(text: string): string {
  let out = ''
  for (const ch of text.toLowerCase()) {
    const folded = LOOK_ALIKES[ch] ?? ch
    if (/[\p{L}\p{N}]/u.test(folded)) out += folded
  }
  return out
}

/** All the words' keys glued into one string (so line breaks and hyphenation don't matter), with who owns each char. */
interface Stream {
  text: string
  owner: number[]
  starts: Set<number>
  ends: Set<number>
}

function buildStream(words: readonly OcrWord[]): Stream {
  let text = ''
  const owner: number[] = []
  const starts = new Set<number>()
  const ends = new Set<number>()
  words.forEach((word, index) => {
    const key = matchKey(word.text)
    if (key === '') return
    starts.add(text.length)
    text += key
    for (let i = 0; i < key.length; i++) owner.push(index)
    ends.add(text.length)
  })
  return { text, owner, starts, ends }
}

/**
 * Every place `key` appears among the words, as the word indexes it covers. An appearance counts when at least one
 * end lines up with a word edge ("Maria" in "Maria's" counts; "ana" inside "banana" does not). Keys shorter than
 * 3 characters must line up at both ends, or they would match half the page.
 */
function findInWords(stream: Stream, key: string): Array<{ words: number[]; source: 'word' | 'partial' }> {
  const found: Array<{ words: number[]; source: 'word' | 'partial' }> = []
  if (key === '') return found
  for (let at = stream.text.indexOf(key); at !== -1; at = stream.text.indexOf(key, at + 1)) {
    const end = at + key.length
    const startOk = stream.starts.has(at)
    const endOk = stream.ends.has(end)
    if (!(startOk && endOk) && (key.length < 3 || !(startOk || endOk))) continue
    const words = [...new Set(stream.owner.slice(at, end))]
    found.push({ words, source: startOk && endOk ? 'word' : 'partial' })
  }
  return found
}

/** The OCR lines (numbered like OcrWord.line) whose text holds `key`. Blank lines don't count, as in wordsFromBlocks. */
function findInLines(ocrText: string, key: string): number[] {
  if (key === '') return []
  const lines = ocrText.split('\n').filter((line) => line.trim() !== '')
  return lines.flatMap((line, index) => (matchKey(line).includes(key) ? [index] : []))
}

// ---------------------------------------------------------------------------------------------
// Boxes

/** "[EMPLOYEE_2]" -> PERSON. Placeholder prefixes are not category names (see PREFIX in placeholders.ts). */
const CATEGORY_OF_PREFIX: Record<string, Category> = {
  EMPLOYEE: 'PERSON',
  ID: 'OTHER_ID',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  ADDRESS: 'ADDRESS',
  MEDICAL_DETAIL: 'MEDICAL',
  SALARY: 'SALARY',
  DOB: 'DATE_OF_BIRTH',
  ROLE: 'ROLE',
  DEPT: 'DEPARTMENT',
  TENURE: 'TENURE',
  FAMILY_MEDICAL: 'FAMILY_MEDICAL',
}

export function categoryOf(placeholder: string): Category {
  return CATEGORY_OF_PREFIX[placeholder.slice(1, placeholder.lastIndexOf('_'))] ?? 'OTHER_ID'
}

function clampRect(rect: Rect, size: { width: number; height: number }): Rect {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(size.width, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(size.height, Math.ceil(rect.y + rect.height))
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

/** One padded box per line around the given words (so the gap between "Maria" and "Santos" is covered too). */
function boxesAround(words: readonly OcrWord[], padding: number, size: { width: number; height: number }): Rect[] {
  const byLine = new Map<number, OcrWord[]>()
  for (const word of words) byLine.set(word.line, [...(byLine.get(word.line) ?? []), word])
  return [...byLine.values()].map((line) => {
    const x0 = Math.min(...line.map((w) => w.x)) - padding
    const y0 = Math.min(...line.map((w) => w.y)) - padding
    const x1 = Math.max(...line.map((w) => w.x + w.w)) + padding
    const y1 = Math.max(...line.map((w) => w.y + w.h)) + padding
    return clampRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, size)
  })
}

function inside(word: OcrWord, size: { width: number; height: number }): boolean {
  return word.w > 0 && word.h > 0 && word.x >= 0 && word.y >= 0 && word.x + word.w <= size.width && word.y + word.h <= size.height
}

/**
 * Decides every black box for one page: each string the redaction hid (full values and name parts, every time it
 * appears) is matched to the OCR words. See the top of this file for what happens when that fails.
 */
export function planBlackout(
  ocr: OcrResult,
  hidden: Readonly<Record<string, string>>,
  size: { width: number; height: number },
  options: PlanOptions = {},
): Plan {
  const padding = options.padding ?? DEFAULT_PADDING
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const stream = buildStream(ocr.words)
  const boxes: BlackoutBox[] = []
  let unplaced = 0

  // A box already inside another one (a name part inside the full name's box) adds nothing, so it is skipped.
  const within = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
  const add = (rects: Rect[], category: Category, source: BoxSource) => {
    for (const rect of rects) {
      if (rect.width === 0 || rect.height === 0 || boxes.some((box) => within(rect, box))) continue
      boxes.push({ ...rect, category, source })
    }
  }

  // Longest first, so a full name's box is made before its parts' (the parts then add nothing new).
  const entries = Object.entries(hidden).sort((a, b) => b[0].length - a[0].length)
  for (const [text, placeholder] of entries) {
    const key = matchKey(text)
    const category = categoryOf(placeholder)
    const matches = findInWords(stream, key)
    if (matches.length > 0) {
      for (const match of matches) {
        add(boxesAround(match.words.map((i) => ocr.words[i]).filter((w) => w !== undefined), padding, size), category, match.source)
      }
      continue
    }
    const lines = findInLines(ocr.text, key)
    const lineWords = ocr.words.filter((word) => lines.includes(word.line))
    if (lineWords.length === 0) {
      unplaced += 1
      continue
    }
    add(boxesAround(lineWords, padding, size), category, 'line')
  }

  const review = ocr.words
    .filter((word) => word.confidence < minConfidence)
    .flatMap((word) => boxesAround([word], padding, size))
  const outside = ocr.words.filter((word) => !inside(word, size)).length
  return { boxes, review, unplaced, outside }
}

// ---------------------------------------------------------------------------------------------
// The whole flow, with redaction and painting passed in

/** An opened page image: its size, and a way to paint a black-boxed COPY of it (the original is never changed). */
export interface OpenedImage<Canvas> {
  width: number
  height: number
  paint(rects: readonly Rect[]): Promise<{ blob: Blob; canvas: Canvas }>
}

export interface BlackoutParts<Image, Canvas> {
  /** On-device redaction of the OCR text. */
  redact(text: string): Promise<RedactionLike>
  open(image: Image): Promise<OpenedImage<Canvas>>
}

export type BlockedReason =
  /** Redaction found details it couldn't hide. */
  | 'redaction-blocked'
  /** A hidden detail couldn't be found on the page, so we don't know where to paint. */
  | 'unplaced'
  /** The OCR boxes don't fit this image, so the boxes would land in the wrong place. */
  | 'image-mismatch'
  /** Too many words were read with low confidence: details in them can't be found. Nothing was redacted or painted. */
  | 'hard-to-read'

export type BlackoutResult<Canvas> =
  | {
      status: 'ok'
      /** The blacked-out copy as a PNG. Stays on this laptop: never send it anywhere. */
      blob: Blob
      /** The same copy as a canvas (the scan screen and pagesToPdf() use canvases). */
      canvas: Canvas
      /** The OCR text with placeholders. The only thing from a scan that may go to the cloud. */
      redactedText: string
      boxes: BlackoutBox[]
      /** Low-confidence words to look at before trusting the result. */
      review: Rect[]
      /** True when a person should check the page: low-confidence words, a whole-line box, or a weaker engine. */
      needsReview: boolean
      engine: string
    }
  | {
      status: 'blocked'
      reason: BlockedReason
      /** Counts only, safe to show: how many leaks, unplaced details, misfit boxes or unclear words. */
      count: number
      /** The engine that ran, or null when the page was refused before redaction. */
      engine: string | null
    }

/**
 * The text to redact: the OCR text (or the words joined by line when the text is missing), with OCR's stray spaces
 * around "@" closed up, so "jordan.example @example.com" is still seen as an email. Matching to the words ignores
 * spaces, so the boxes still line up.
 */
export function ocrText(ocr: OcrResult): string {
  let text = ocr.text
  if (text.trim() === '') {
    const lines: string[][] = []
    for (const word of ocr.words) (lines[word.line] ??= []).push(word.text)
    text = lines.map((line) => (line ?? []).join(' ')).join('\n')
  }
  return text.replace(/(?<=[\p{L}\p{N}._%+-])[ \t]*@[ \t]*(?=[\p{L}\p{N}])/gu, '@')
}

export async function runBlackout<Image, Canvas>(
  image: Image,
  ocr: OcrResult,
  parts: BlackoutParts<Image, Canvas>,
  options: PlanOptions = {},
): Promise<BlackoutResult<Canvas>> {
  const unclear = unclearWords(ocr.words, options.minConfidence)
  if (unclear.share > (options.maxUnclearShare ?? DEFAULT_MAX_UNCLEAR_SHARE)) {
    return { status: 'blocked', reason: 'hard-to-read', count: unclear.count, engine: null }
  }

  const text = ocrText(ocr)
  const redaction = await parts.redact(text)
  if (redaction.status !== 'ok') {
    return { status: 'blocked', reason: 'redaction-blocked', count: redaction.leaks.length, engine: redaction.engine }
  }

  const opened = await parts.open(image)
  const plan = planBlackout({ text, words: ocr.words }, redaction.map.lookup, opened, options)
  if (plan.outside > 0) return { status: 'blocked', reason: 'image-mismatch', count: plan.outside, engine: redaction.engine }
  if (plan.unplaced > 0) return { status: 'blocked', reason: 'unplaced', count: plan.unplaced, engine: redaction.engine }

  const { blob, canvas } = await opened.paint(plan.boxes)
  return {
    status: 'ok',
    blob,
    canvas,
    redactedText: redaction.redactedText,
    boxes: plan.boxes,
    review: plan.review,
    needsReview: plan.review.length > 0 || plan.boxes.some((box) => box.source === 'line') || redaction.needsCarefulReview,
    engine: redaction.engine,
  }
}
