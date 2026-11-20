// Swap sensitive text for placeholders like [EMPLOYEE_1], and swap them back after drafting.
// The model only FINDS entities; this code does the replacing so it is consistent:
// the same person always gets the same placeholder. Pure functions (no Firebase).
// The map never leaves the browser.

import { wholeWordRegex } from '../rules/rules.ts'

export const CATEGORIES = [
  'PERSON',
  'EMPLOYEE_ID',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'MEDICAL',
  'SALARY',
  'DATE_OF_BIRTH',
  'ROLE',
  'DEPARTMENT',
  'OTHER_ID',
] as const

export type Category = (typeof CATEGORIES)[number]

export interface Entity {
  text: string
  category: Category
}

// Placeholder prefix per category: PERSON -> [EMPLOYEE_1], DEPARTMENT -> [DEPT_1], ...
const PREFIX: Record<Category, string> = {
  PERSON: 'EMPLOYEE',
  EMPLOYEE_ID: 'ID',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  ADDRESS: 'ADDRESS',
  MEDICAL: 'MEDICAL',
  SALARY: 'SALARY',
  DATE_OF_BIRTH: 'DOB',
  ROLE: 'ROLE',
  DEPARTMENT: 'DEPT',
  OTHER_ID: 'ID',
}

export interface PlaceholderMap {
  /** "[EMPLOYEE_1]" -> "Maria Santos" (used to restore) */
  originals: Record<string, string>
  /** lowercased text -> placeholder, including name parts like "maria" */
  lookup: Record<string, string>
}

export function emptyMap(): PlaceholderMap {
  return { originals: {}, lookup: {} }
}

/** Every original string the map hides (full values and name parts), for leak re-checks. */
export function sensitiveStrings(map: PlaceholderMap): string[] {
  return Object.keys(map.lookup)
}

/** Count of placeholders per prefix, e.g. { EMPLOYEE: 3, SALARY: 1 }. Counts only, no content. */
export function countByPrefix(map: PlaceholderMap): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const placeholder of Object.keys(map.originals)) {
    const prefix = placeholder.slice(1, placeholder.lastIndexOf('_'))
    counts[prefix] = (counts[prefix] ?? 0) + 1
  }
  return counts
}

function nextPlaceholder(map: PlaceholderMap, prefix: string): string {
  let n = 1
  while (map.originals[`[${prefix}_${n}]`] !== undefined) n++
  return `[${prefix}_${n}]`
}

function isUsable(value: string): boolean {
  return value.length >= 2 && !/\[[A-Z_]+_\d+\]/.test(value)
}

const HAS_YEAR = /\b(?:19|20)\d{2}\b/
const HAS_AGE = /\b\d{1,3}\s*(?:years?|yrs?)\b|\baged?\s*\d{1,3}\b/i
const BIRTH_CUE = /\b(?:born|birth|birthday|dob|d\.o\.b)\b/i
const MONTH_DAY = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i
const EVENT_WORD =
  /\b(?:meeting|call|interview|session|review|hearing|incident|conversation|training|huddle)\b/i

/**
 * Drops entities the model got wrong in ways a rule can catch. Case timelines need
 * event dates and events, so these must stay visible:
 * - An event date like "Oct 3" labeled DATE_OF_BIRTH. A date only counts as a birth date
 *   if it has a year or an age, or a word like "born"/"DOB" appears just before it.
 * - An event like "Oct 3 team meeting" labeled DEPARTMENT. A team name can't contain a
 *   date or an event word.
 */
export function filterEntities(text: string, entities: Entity[]): Entity[] {
  return entities.filter((e) => {
    if (e.category === 'DEPARTMENT') return !MONTH_DAY.test(e.text) && !EVENT_WORD.test(e.text)
    if (e.category !== 'DATE_OF_BIRTH') return true
    if (HAS_YEAR.test(e.text) || HAS_AGE.test(e.text)) return true
    const at = text.toLowerCase().indexOf(e.text.trim().toLowerCase())
    if (at < 0) return false
    return BIRTH_CUE.test(text.slice(Math.max(0, at - 30), at))
  })
}

/**
 * Replaces each entity found in `text` with a placeholder. Entities the model invented
 * (not actually in the text) are ignored. Returns new text and an updated copy of the map.
 */
export function applyEntities(
  text: string,
  entities: Entity[],
  previous: PlaceholderMap = emptyMap(),
): { text: string; map: PlaceholderMap } {
  const map: PlaceholderMap = {
    originals: { ...previous.originals },
    lookup: { ...previous.lookup },
  }

  // Keep only entities that really appear in the text, stored with the note's own
  // spelling and casing (the model may return "oct 3" for "Oct 3").
  const valid: Entity[] = []
  for (const e of filterEntities(text, entities)) {
    const value = e.text.trim()
    if (!isUsable(value) || !PREFIX[e.category]) continue
    const found = text.match(wholeWordRegex(value))
    if (found) valid.push({ category: e.category, text: found[0] })
  }
  // Assign placeholders. Longest first so "Maria Santos" wins over "Maria".
  valid.sort((a, b) => b.text.length - a.text.length)

  for (const entity of valid) {
    const key = entity.text.toLowerCase()
    if (map.lookup[key]) continue
    const placeholder = nextPlaceholder(map, PREFIX[entity.category])
    map.originals[placeholder] = entity.text
    map.lookup[key] = placeholder

    // A full name also hides its parts, so a later "Maria" alone is caught too.
    // Restoring a part gives back the full name, which reads fine in a draft.
    if (entity.category === 'PERSON') {
      for (const part of entity.text.split(/\s+/)) {
        const partKey = part.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, '')
        if (partKey.length >= 3 && !map.lookup[partKey]) map.lookup[partKey] = placeholder
      }
    }
  }

  // Replace, longest strings first.
  let result = text
  const keys = Object.keys(map.lookup).sort((a, b) => b.length - a.length)
  for (const key of keys) result = result.replace(wholeWordRegex(key), map.lookup[key])
  return { text: result, map }
}

export const PLACEHOLDER = /\[([A-Z_]+)_\d+\]/g

/**
 * Puts the real values back. Runs only in the browser after the cloud draft returns.
 * `withhold` lists prefixes that must NOT be restored (e.g. MEDICAL in a manager email);
 * those become "[withheld]".
 */
export function restore(text: string, map: PlaceholderMap, withhold: string[] = []): string {
  return text.replace(PLACEHOLDER, (placeholder, prefix: string) =>
    withhold.includes(prefix) ? '[withheld]' : (map.originals[placeholder] ?? placeholder),
  )
}
