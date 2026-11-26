// Every part of every found name, hidden everywhere it appears, including OCR misspellings. Pure, tested in Node.
//
// applyEntities() already hides a found name's parts when they are spelled exactly ("Luis Hernandez" also hides a
// later "Hernandez"). Scanned text adds misspellings ("whitield" for Whitfield). hideNameParts() hides those too,
// with the SAME placeholder as the full name, so [EMPLOYEE_2] stays one person in the draft.
//
// A misspelling counts when it is close (1 typo for 4–6 letters, 2 for 7+; see fuzzy.ts), starts with the same
// letter, and is capitalised, unless the name part is 7+ letters long (OCR loses capitals too, as in "whitield").
// Short or common words never count, so "eyes" never becomes Reyes.

import { closeEnough } from '../rules/fuzzy.ts'
import { wholeWordRegex } from '../rules/rules.ts'
import { NAME_TITLES, replaceOutsidePlaceholders, maskPlaceholders, type PlaceholderMap } from './placeholders.ts'

// Everyday words a few letters away from a common name part. Never treated as a misspelt name.
const COMMON_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'they', 'them', 'then', 'than', 'when', 'were', 'what', 'will', 'your',
  'said', 'also', 'into', 'only', 'over', 'some', 'such', 'very', 'well', 'eyes', 'manager', 'employee', 'meeting',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'signed', 'called', 'stated',
  'reported', 'report', 'review', 'warning', 'written', 'verbal', 'shift', 'today', 'later', 'after', 'before',
])

/** The name parts the map hides, lower case, each with its person's placeholder. Titles and 1–2 letter parts skipped. */
export function nameParts(map: PlaceholderMap): Map<string, string> {
  const parts = new Map<string, string>()
  for (const [placeholder, original] of Object.entries(map.originals)) {
    if (!placeholder.startsWith('[EMPLOYEE_')) continue
    // Split on spaces only: "Min-jun" must not hide every "Jun" (the month).
    for (const raw of original.split(/\s+/)) {
      const part = raw.toLowerCase().replace(/[^\p{L}'’]/gu, '')
      if (part.length >= 3 && !NAME_TITLES.has(part) && !parts.has(part)) parts.set(part, placeholder)
    }
  }
  return parts
}

/** The name part `word` is a misspelling of (see the top of this file), or undefined. */
function misspeltPart(word: string, parts: Map<string, string>): string | undefined {
  const lower = word.toLowerCase()
  if (lower.length < 4 || COMMON_WORDS.has(lower) || NAME_TITLES.has(lower)) return undefined
  const capitalised = /^\p{Lu}/u.test(word)
  for (const part of parts.keys()) {
    if (part === lower) return part
    if (part[0] !== lower[0] || (!capitalised && part.length < 7)) continue
    if (closeEnough(lower, part)) return part
  }
  return undefined
}

/**
 * Hides every other spelling of a found name's parts in `text` (outside placeholders), with that person's
 * placeholder. Each spelling is added to the map's lookup, so the leak re-check and the photo boxes use it too.
 */
export function hideNameParts(text: string, map: PlaceholderMap): { text: string; map: PlaceholderMap; added: number } {
  const parts = nameParts(map)
  if (parts.size === 0) return { text, map, added: 0 }
  const lookup = { ...map.lookup }
  const found = new Map<string, string>()
  for (const match of maskPlaceholders(text).matchAll(/\p{L}[\p{L}'’]*/gu)) {
    const word = match[0]
    const key = word.toLowerCase()
    if (lookup[key] || found.has(key)) continue
    const part = misspeltPart(word, parts)
    if (part) found.set(key, parts.get(part) as string)
  }
  if (found.size === 0) return { text, map, added: 0 }
  let result = text
  for (const [key, placeholder] of found) {
    lookup[key] = placeholder
    result = replaceOutsidePlaceholders(result, wholeWordRegex(key), placeholder)
  }
  return { text: result, map: { originals: { ...map.originals }, lookup }, added: found.size }
}
