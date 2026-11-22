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
  'TENURE',
  'FAMILY_MEDICAL',
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
  TENURE: 'TENURE',
  // Its own prefix (not MEDICAL) so the cloud never mistakes a relative's condition for the
  // employee's. Every template that withholds MEDICAL must withhold this too (see templates.ts).
  FAMILY_MEDICAL: 'FAMILY_MEDICAL',
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

// "the only Filipino nurse in the ICU" -> role "the only Filipino nurse" + group "the ICU".
// Splits on the first in/on/at/within. The group must start with an article or a capital
// ("in charge of nights" is not a group), so a bad split keeps the whole phrase as one ROLE.
const ROLE_THEN_GROUP = /^(.{3,}?)\s+(?:in|on|at|within)\s+(.{2,60})$/i
const GROUP_START = /^(?:(?:the|our|their|his|her|a|an)\s|\p{Lu})/u
const LEADING_ARTICLE = /^(?:the|our|a|an)\s+/i

/**
 * Turns one ROLE or TENURE phrase that includes its team into two entities, so the text reads
 * "[ROLE_1] in [DEPT_1]" (or "[TENURE_1] in [DEPT_1]") and each part is reused on its own.
 * Other entities pass through.
 */
export function splitRoleAndGroup(entities: Entity[]): Entity[] {
  return entities.flatMap((e): Entity[] => {
    if (e.category !== 'ROLE' && e.category !== 'TENURE') return [e]
    const m = e.text.trim().match(ROLE_THEN_GROUP)
    if (!m || !GROUP_START.test(m[2]) || MONTH_DAY.test(m[2]) || EVENT_WORD.test(m[2])) return [e]
    return [
      { text: m[1], category: e.category },
      { text: m[2], category: 'DEPARTMENT' },
    ]
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
  for (const e of filterEntities(text, splitRoleAndGroup(entities))) {
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

    // "the Reno warehouse" also hides a later "Reno warehouse" (same placeholder). Skipped for a
    // bare one-word lowercase noun ("warehouse"), which would hide ordinary words.
    if (entity.category === 'DEPARTMENT') {
      const bare = entity.text.replace(LEADING_ARTICLE, '')
      const bareKey = bare.toLowerCase()
      if (bare !== entity.text && bare.length >= 3 && (/\s/.test(bare) || /^\p{Lu}/u.test(bare)) && !map.lookup[bareKey]) {
        map.lookup[bareKey] = placeholder
      }
    }
  }

  // Replace, longest strings first.
  let result = text
  const keys = Object.keys(map.lookup).sort((a, b) => b.length - a.length)
  for (const key of keys) result = result.replace(wholeWordRegex(key), map.lookup[key])

  // Forget placeholders made in this call that ended up nowhere in the text (a department that
  // sat inside a longer phrase), so counts and the map only describe what is really hidden.
  for (const placeholder of Object.keys(map.originals)) {
    if (previous.originals[placeholder] !== undefined || result.includes(placeholder)) continue
    delete map.originals[placeholder]
    for (const [key, value] of Object.entries(map.lookup)) if (value === placeholder) delete map.lookup[key]
  }
  return { text: result, map }
}

// Finds a placeholder the way the model may really write it back, not only the exact
// "[EMPLOYEE_1]" we sent. Accepts: any letter case, spaces inside the brackets, "_" / "-" / a
// space before the number, leading zeros ("[EMPLOYEE_01]"), and markdown escapes
// ("\[EMPLOYEE\_1\]"). Padding is capped ({0,2}) so odd input can't make the match slow.
// Groups: 1 = prefix, 2 = number.
const PLACEHOLDER_PATTERN = String.raw`\\?\[\s{0,2}([A-Za-z]+(?:\\?_[A-Za-z]+)*)\s{0,2}(?:\\?_|-|\s)\s{0,2}(\d{1,6})\s{0,2}\\?\]`

export interface PlaceholderMatch {
  /** The text exactly as the model wrote it, e.g. "[ employee 1 ]". */
  raw: string
  /** Canonical form, e.g. "[EMPLOYEE_1]". */
  placeholder: string
  /** Canonical prefix, e.g. "EMPLOYEE". */
  prefix: string
  /** The map has an original for it. */
  known: boolean
  /** The model wrote it in the exact canonical form. */
  exact: boolean
}

function describe(raw: string, rawPrefix: string, rawNumber: string, map: PlaceholderMap): PlaceholderMatch {
  const prefix = rawPrefix.replace(/\\/g, '').toUpperCase()
  const placeholder = `[${prefix}_${rawNumber.replace(/^0+(?=\d)/, '')}]`
  return { raw, placeholder, prefix, known: map.originals[placeholder] !== undefined, exact: raw === placeholder }
}

/**
 * Every placeholder-shaped piece of `text`, in order and including repeats. A reformatted
 * match that is NOT in the map ("[Table 1]") is ordinary text, so it is left out; an exact
 * "[EMPLOYEE_9]" that isn't in the map is kept, because that is a placeholder the model invented.
 */
export function findPlaceholders(text: string, map: PlaceholderMap): PlaceholderMatch[] {
  const found: PlaceholderMatch[] = []
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_PATTERN, 'g'))) {
    const match = describe(m[0], m[1], m[2], map)
    if (match.known || match.exact) found.push(match)
  }
  return found
}

/**
 * Puts the real values back, every time a placeholder appears and however the model
 * formatted it. Runs only in the browser after the cloud draft returns; reads the in-memory
 * map and never changes or stores it.
 * `withhold` lists prefixes that must NOT be restored (e.g. MEDICAL in a manager email);
 * those become "[withheld]". Anything that isn't one of our placeholders is left untouched.
 */
export function restore(text: string, map: PlaceholderMap, withhold: string[] = []): string {
  return text.replace(new RegExp(PLACEHOLDER_PATTERN, 'g'), (raw, rawPrefix: string, rawNumber: string) => {
    const match = describe(raw, rawPrefix, rawNumber, map)
    if (!match.known && !match.exact) return raw
    if (withhold.includes(match.prefix)) return '[withheld]'
    return map.originals[match.placeholder] ?? raw
  })
}
