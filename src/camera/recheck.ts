// The photo recheck: after the black boxes are painted, read the blacked-out copy again and look for anything that
// was hidden in the text but still shows on the picture. Pure (no DOM, no OCR engine), so it runs under `node --test`;
// blackout.ts plugs in the real text reader and canvas.
//
// 1. Read the blacked-out copy again (on this device).
// 2. "Must not appear": every string the redaction hid for this page, plus each word of a multi-word name (3+ letters).
// 3. Look for each one among the words, ignoring case, allowing OCR typos (1 for 4–6 letters, 2 for 7+; see fuzzy.ts)
//    as long as the first letter is right, so ordinary words like "eyes" don't count as "Reyes".
// 4. Paint a black box over every hit. A hit whose box can't be used blacks out its whole line.
// 5. Up to 2 rounds of fixes. Anything still found after that blocks the page: no download, no send.
//
// Nothing here is sent anywhere, and the result holds counts and positions only, never the hidden text.

import type { Category } from '../ai/placeholders.ts'
import { closeEnough, typoBudget } from '../rules/fuzzy.ts'
import { boxesAround, categoryOf, matchKey, type Rect } from './blackoutPlan.ts'
import type { OcrResult, OcrWord } from './ocr.ts'

/** One string that must not be readable on the blacked-out copy. Stays in memory on this device. */
export interface MustHide {
  key: string
  /** How many words it spans in the note ("Dan Reyes" = 2), so a multi-word value is looked for across words. */
  words: number
  category: Category
}

// Titles and words that sit next to names but aren't names: never looked for on their own.
const NOT_NAME_PARTS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'rn', 'md', 'np', 'pa', 'phd', 'jr', 'sr', 'rev', 'prof'])

/** Every string the redaction hid (full values, name parts and other spellings), plus each word of a multi-word name. */
export function mustNotAppear(map: { originals: Readonly<Record<string, string>>; lookup: Readonly<Record<string, string>> }): MustHide[] {
  const found = new Map<string, MustHide>()
  const add = (text: string, placeholder: string) => {
    const key = matchKey(text)
    if (key.length < 3 || NOT_NAME_PARTS.has(key) || found.has(key)) return
    found.set(key, { key, words: Math.max(1, text.trim().split(/\s+/).length), category: categoryOf(placeholder) })
  }
  for (const [placeholder, original] of Object.entries(map.originals)) {
    add(original, placeholder)
    if (categoryOf(placeholder) === 'PERSON') for (const part of original.split(/[\s]+/)) add(part, placeholder)
  }
  for (const [text, placeholder] of Object.entries(map.lookup)) add(text, placeholder)
  return [...found.values()]
}

/** A hidden string still readable on the picture: the words it covers. */
export interface Survivor {
  words: number[]
  category: Category
}

/**
 * Every place a must-hide string can still be read among `words`: the string is compared with runs of 1 to n+1
 * neighbouring words glued together (OCR splits and joins words), allowing typos by the string's length.
 */
export function findSurvivors(words: readonly OcrWord[], items: readonly MustHide[]): Survivor[] {
  const keys = words.map((word) => matchKey(word.text))
  const hits: Survivor[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const budget = typoBudget(item.key.length)
    for (let size = Math.max(1, item.words - 1); size <= item.words + 1; size++) {
      for (let start = 0; start + size <= words.length; start++) {
        const run = keys.slice(start, start + size)
        if (run.some((key) => key === '')) continue
        const glued = run.join('')
        if (Math.abs(glued.length - item.key.length) > budget) continue
        // A typo match must keep the first letter: "Reyez" is Reyes, "eyes" is just a word.
        if (glued !== item.key && (glued[0] !== item.key[0] || !closeEnough(glued, item.key))) continue
        const indexes = Array.from({ length: size }, (_, i) => start + i)
        const id = indexes.join(',')
        if (seen.has(id)) continue
        seen.add(id)
        hits.push({ words: indexes, category: item.category })
      }
    }
  }
  return hits
}

/** How many separate details the hits are: hits that share a word count once ("Dan Reyes" and "Reyes" are one). */
export function countDetails(hits: readonly Survivor[]): number {
  const groups: Array<Set<number>> = []
  for (const hit of hits) {
    const touching = groups.filter((group) => hit.words.some((index) => group.has(index)))
    const merged = new Set<number>(hit.words)
    for (const group of touching) {
      for (const index of group) merged.add(index)
      groups.splice(groups.indexOf(group), 1)
    }
    groups.push(merged)
  }
  return groups.length
}

function usable(word: OcrWord | undefined, size: { width: number; height: number }): word is OcrWord {
  return word !== undefined && word.w > 0 && word.h > 0 && word.x >= 0 && word.y >= 0 && word.x + word.w <= size.width && word.y + word.h <= size.height
}

/** The black boxes for some hits: over the hit's words, or over its whole line when a word's box can't be used. */
export function survivorBoxes(
  words: readonly OcrWord[],
  hits: readonly Survivor[],
  size: { width: number; height: number },
  padding = 4,
): { boxes: Array<Rect & { category: Category }>; unplaced: number } {
  const boxes: Array<Rect & { category: Category }> = []
  let unplaced = 0
  for (const hit of hits) {
    const hitWords = hit.words.map((index) => words[index])
    let target = hitWords.filter((word) => usable(word, size))
    if (target.length < hitWords.length) {
      const lines = new Set(hitWords.flatMap((word) => (word ? [word.line] : [])))
      target = words.filter((word) => lines.has(word.line) && usable(word, size))
    }
    if (target.length === 0) {
      unplaced += 1
      continue
    }
    for (const rect of boxesAround(target, padding, size)) if (rect.width > 0 && rect.height > 0) boxes.push({ ...rect, category: hit.category })
  }
  return { boxes, unplaced }
}

export interface RecheckParts<Canvas> {
  /** Reads the text on a canvas, on this device. */
  read(canvas: Canvas): Promise<OcrResult>
  /** A copy of `canvas` with black boxes painted on it. */
  paint(canvas: Canvas, rects: readonly Rect[]): Promise<{ canvas: Canvas; blob: Blob }>
  size: { width: number; height: number }
}

export type RecheckResult<Canvas> =
  | {
      status: 'ok'
      canvas: Canvas
      /** The new copy as a PNG, when the recheck painted anything. */
      blob?: Blob
      /** How many missed details were found and blacked out (0 = the first copy was already clean). */
      fixed: number
      boxes: Array<Rect & { category: Category }>
    }
  | { status: 'blocked'; fixed: number; left: number }

/** Most rounds of fixes before giving up and blocking the page. */
export const RECHECK_ROUNDS = 2

/** Reads the blacked-out copy again and covers whatever hidden detail still shows (see the top of this file). */
export async function recheckPhoto<Canvas>(
  canvas: Canvas,
  items: readonly MustHide[],
  parts: RecheckParts<Canvas>,
  options: { rounds?: number; padding?: number } = {},
): Promise<RecheckResult<Canvas>> {
  const rounds = options.rounds ?? RECHECK_ROUNDS
  let fixed = 0
  let blob: Blob | undefined
  const boxes: Array<Rect & { category: Category }> = []
  if (items.length === 0) return { status: 'ok', canvas, fixed, boxes }
  for (let round = 0; ; round++) {
    const ocr = await parts.read(canvas)
    const hits = findSurvivors(ocr.words, items)
    if (hits.length === 0) return { status: 'ok', canvas, blob, fixed, boxes }
    const count = countDetails(hits)
    if (round >= rounds) return { status: 'blocked', fixed, left: count }
    const placed = survivorBoxes(ocr.words, hits, parts.size, options.padding)
    if (placed.unplaced > 0) return { status: 'blocked', fixed, left: placed.unplaced }
    ;({ canvas, blob } = await parts.paint(canvas, placed.boxes))
    boxes.push(...placed.boxes)
    fixed += count
  }
}
