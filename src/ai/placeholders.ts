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
  // The original diagnosis/condition stays in the in-memory map under [MEDICAL_DETAIL_n]. Only the
  // placeholder can reach the cloud, never the value (see restrictionPrompt.ts).
  MEDICAL: 'MEDICAL_DETAIL',
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

/** Every placeholder prefix a map can hold, once each. The send log and its Firestore rules allow only these. */
export const PLACEHOLDER_PREFIXES: readonly string[] = [...new Set(Object.values(PREFIX))]

/** Health placeholders: never restored in manager or employee drafts, never shown to the cloud as text. */
export const HEALTH_PREFIXES = ['MEDICAL_DETAIL', 'FAMILY_MEDICAL'] as const

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
  // Not a placeholder, and not a placeholder's name without its brackets ("PHONE_1"), which a model may echo back.
  return value.length >= 2 && !/\[[A-Z_]+_\d+\]/.test(value) && !/^[A-Z]+(?:_[A-Z]+)*_\d+$/i.test(value)
}

/**
 * Titles and particles that sit inside a written name but are not the person: "Dr", "Mrs", "RN", "van". A name's
 * parts are hidden everywhere, so these must never be one of them (or every "Mrs" in the note would vanish).
 */
export const NAME_TITLES: ReadonlySet<string> = new Set([
  'dr', 'mr', 'mrs', 'ms', 'mx', 'miss', 'rn', 'md', 'np', 'pa', 'lpn', 'cna', 'phd', 'jr', 'sr', 'ii', 'iii', 'iv',
  'rev', 'prof', 'esq', 'dds', 'van', 'von', 'del', 'der', 'den', 'des', 'las', 'los', 'the', 'and',
])

/** Our placeholders as they appear in text: [EMPLOYEE_1], [MEDICAL_DETAIL_2]. */
const PLACEHOLDER_TOKEN = /\[[A-Z]+(?:_[A-Z]+)*_\d+\]/g

/** The text with each placeholder blanked to spaces of the same length, so searches skip them but positions still line up. */
export function maskPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_TOKEN, (token) => ' '.repeat(token.length))
}

/** Replaces matches of `pattern` only in the parts of `text` outside placeholders. */
export function replaceOutsidePlaceholders(text: string, pattern: RegExp, value: string): string {
  return text
    .split(/(\[[A-Z]+(?:_[A-Z]+)*_\d+\])/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(pattern, value)))
    .join('')
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
 * "the Reno warehouse" -> "Reno warehouse": the article stays in the text ("in the [DEPT_1]"),
 * so a later "Reno warehouse" gets the same placeholder and restoring never adds or drops "the".
 * A bare one-word lowercase noun ("the warehouse") keeps its article, so we don't hide every
 * ordinary "warehouse" in the note.
 */
function withoutArticle(team: string): string {
  const bare = team.replace(LEADING_ARTICLE, '')
  return bare !== team && bare.length >= 3 && (/\s/.test(bare) || /^\p{Lu}/u.test(bare)) ? bare : team
}

// Phrases whose first letter depends on where they sit ("The only woman..." / "...the only
// woman"). Names, IDs and emails keep their spelling everywhere.
const SENTENCE_CASE: ReadonlySet<Category> = new Set(['ROLE', 'DEPARTMENT', 'TENURE', 'MEDICAL', 'FAMILY_MEDICAL'])
const SENTENCE_CASE_PREFIXES: ReadonlySet<string> = new Set([...SENTENCE_CASE].map((c) => PREFIX[c]))
const LEADING_DETERMINER = /^(?:The|A|An|Our|Their|His|Her|My|This|That)\b/

/** True if `index` starts a sentence, a line or a bullet. */
function atSentenceStart(text: string, index: number): boolean {
  const before = text.slice(0, index)
  return /^\s*(?:[-*•]\s+)?$/.test(before) || /(?:[.!?]["')\]]?\s+|\n\s*(?:[-*•]\s+)?)$/.test(before.slice(-12))
}

/**
 * The note's own spelling of `value`. For phrases, prefer a mid-sentence occurrence so a
 * capital that only comes from starting a sentence isn't stored ("Night crew leads..." later
 * restored mid-sentence as "the Night crew"). If every occurrence starts a sentence, a leading
 * "The"/"A"/... is stored in lower case; restore() capitalizes it again at a sentence start.
 */
function noteSpelling(text: string, value: string, category: Category): string | undefined {
  // Search outside placeholders only: "PHONE_1" inside "[PHONE_1]" is not something the note says.
  const matches = [...maskPlaceholders(text).matchAll(wholeWordRegex(value))]
  if (!matches.length) return undefined
  if (!SENTENCE_CASE.has(category)) return matches[0][0]
  const mid = matches.find((m) => !atSentenceStart(text, m.index))
  if (mid) return mid[0]
  const first = matches[0][0]
  return LEADING_DETERMINER.test(first) ? first[0].toLowerCase() + first.slice(1) : first
}

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
    const value = e.category === 'DEPARTMENT' ? withoutArticle(e.text.trim()) : e.text.trim()
    if (!isUsable(value) || !PREFIX[e.category]) continue
    const spelling = noteSpelling(text, value, e.category)
    if (spelling) valid.push({ category: e.category, text: spelling })
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
        if (partKey.length >= 3 && !NAME_TITLES.has(partKey) && !map.lookup[partKey]) map.lookup[partKey] = placeholder
      }
    }
  }

  // Replace, longest strings first.
  let result = text
  const keys = Object.keys(map.lookup).sort((a, b) => b.length - a.length)
  // Never inside a placeholder: hiding "Employee" must not turn "[EMPLOYEE_1]" into "[[ROLE_1]_1]".
  for (const key of keys) result = replaceOutsidePlaceholders(result, wholeWordRegex(key), map.lookup[key])

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
// A multi-word prefix ("MEDICAL_DETAIL", "FAMILY_MEDICAL") may come back as "Medical Detail" or
// "medical-detail" too; a look-alike that is not in the map is still left alone (see `known`).
const PLACEHOLDER_PATTERN = String.raw`\\?\[\s{0,2}([A-Za-z]+(?:(?:\\?_|-|\s{1,2})[A-Za-z]+)*)\s{0,2}(?:\\?_|-|\s)\s{0,2}(\d{1,6})\s{0,2}\\?\]`

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
  const prefix = rawPrefix.replace(/\\/g, '').replace(/[\s-]+/g, '_').toUpperCase()
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
 * A phrase (role, team, tenure, medical) that starts a sentence gets a capital first letter.
 * `only` limits restoring to those prefixes; every other placeholder stays as written.
 */
export function restore(
  text: string,
  map: PlaceholderMap,
  withhold: readonly string[] = [],
  only?: readonly string[],
): string {
  return text.replace(
    new RegExp(PLACEHOLDER_PATTERN, 'g'),
    (raw: string, rawPrefix: string, rawNumber: string, offset: number, whole: string) => {
      const match = describe(raw, rawPrefix, rawNumber, map)
      if (!match.known && !match.exact) return raw
      if (only && !only.includes(match.prefix)) return raw
      if (withhold.includes(match.prefix)) return '[withheld]'
      const original = map.originals[match.placeholder]
      if (original === undefined) return raw
      return SENTENCE_CASE_PREFIXES.has(match.prefix) && atSentenceStart(whole, offset)
        ? original[0].toUpperCase() + original.slice(1)
        : original
    },
  )
}
