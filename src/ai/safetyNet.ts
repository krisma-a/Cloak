// Code-side safety net for the Gemini Nano engine. Pure (no Firebase), so tests run in Node.
//
// Nano finds entities, but it misses some, and until now the Nano path only used rules to DETECT a leak
// (then retry, then block). Anything a rule can find is now also HIDDEN by code, after Nano's pass:
//   - every fixed-shape rule (emails, phones, IDs, money, ages, "the only ..." phrases) and medical keyword;
//   - team phrases like "the weekend dispatch team" (DEPARTMENT);
//   - a nickname in quotes right after a hidden name: [EMPLOYEE_1] "Mon" [EMPLOYEE_2];
//   - the visible rest of a hyphenated name glued to a placeholder: [EMPLOYEE_3]-jun Park.
// Names found by the in-browser model are also widened to the whole hyphenated name first
// (extendNameSpans), because that model splits "Min-jun" into "Min" + "jun".
// Developed on Set A only. Set B is the holdout and was not used to choose these rules.

import { applyEntities, type Entity, type PlaceholderMap } from './placeholders.ts'
import { medicalTerms, ruleEntities } from './ruleEntities.ts'

// Words that can follow a name but are not part of it.
const NOT_A_NAME = new Set(
  [
    'HR', 'EE', 'ER', 'The', 'A', 'An', 'And', 'Or', 'But', 'Policy', 'Case', 'Dr', 'Mr', 'Mrs', 'Ms', 'Mx', 'He', 'She',
    'They', 'His', 'Her', 'Their', 'It', 'On', 'In', 'At', 'To', 'From', 'With', 'For', 'Jan', 'Feb', 'Mar', 'Apr',
    'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday', 'Sunday', 'I', 'We', 'You', 'Per', 'See', 'Next', 'Last', 'Severance', 'Salary', 'Payroll',
  ].map((w) => w.toLowerCase()),
)

/** A word that looks like part of a name: Capitalised, or with a stray capital inside ("oYon", a typo). */
function nameWord(word: string): boolean {
  if (word.length < 2 || NOT_A_NAME.has(word.toLowerCase())) return false
  return /^\p{Lu}[\p{L}'’-]*$/u.test(word) || /^\p{Ll}+\p{Lu}[\p{L}'’-]*$/u.test(word)
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Widens PERSON entities (and place entities glued to a lowercase hyphen part, which are really names:
 * "Min" in "Min-jun") to the whole hyphenated name plus one following name word, as written in `text`.
 * "Min" in "Recommended by Min-jun Park." becomes PERSON "Min-jun Park".
 */
export function extendNameSpans(text: string, entities: Entity[]): Entity[] {
  return entities.map((entity) => {
    if (entity.category !== 'PERSON' && entity.category !== 'ADDRESS') return entity
    const at = new RegExp(`(?<![\\p{L}\\p{N}])${escape(entity.text)}(-\\p{Ll}[\\p{L}'’]*)`, 'u').exec(text)
    if (!at) return entity
    if (entity.category === 'ADDRESS' && !/^-\p{Ll}/u.test(at[1])) return entity
    let span = at[0]
    const next = /^\s+([\p{L}'’-]+)/u.exec(text.slice(at.index + span.length))
    if (next && nameWord(next[1])) span += next[0]
    return { text: span.trim(), category: 'PERSON' }
  })
}

// "the weekend dispatch team", "the Line 3 packaging team", "the cold-storage unit". One to three words
// before the group noun, and not a generic one ("the whole team", "the HR team").
const GROUP = /\bthe\s+((?:[\p{L}\d][\p{L}\d'’-]*\s+){0,2}[\p{L}\d][\p{L}\d'’-]*)\s+(team|unit|crew|department|division|squad)\b/giu
const GENERIC_GROUP_WORDS = new Set([
  'whole', 'same', 'entire', 'other', 'new', 'old', 'my', 'our', 'your', 'his', 'her', 'their', 'this', 'that', 'hr',
  'management', 'leadership', 'full', 'rest', 'wider', 'local', 'own',
])

/** Team names that single someone out. The article stays in the text ("the [DEPT_1]"). */
export function groupPhrases(text: string): Entity[] {
  const found: Entity[] = []
  for (const m of text.matchAll(GROUP)) {
    if (m[0].includes('[')) continue
    const words = m[1].toLowerCase().split(/\s+/)
    if (words.some((w) => GENERIC_GROUP_WORDS.has(w))) continue
    found.push({ text: m[0], category: 'DEPARTMENT' })
  }
  return found
}

const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/i

// A placeholder for a person, then a nickname in quotes: [EMPLOYEE_1] "Mon"  /  [EMPLOYEE_1] (“Bea”)
const NICKNAME = /\[EMPLOYEE_\d+\]\s+\(?["“'‘]([\p{Lu}][\p{L}'’-]{1,20})["”'’]\)?/gu
// The visible rest of a hyphenated name glued to a placeholder: [ADDRESS_1]-jun Park
const GLUED_REST = /\[[A-Z_]+_\d+\]-(\p{Ll}[\p{L}'’]*)(?:\s+([\p{L}'’-]+))?/gu

/** Name pieces still visible next to a hidden name. */
export function leftoverNameParts(redactedText: string): Entity[] {
  const found: Entity[] = []
  for (const m of redactedText.matchAll(NICKNAME)) found.push({ text: m[1], category: 'PERSON' })
  for (const m of redactedText.matchAll(GLUED_REST)) {
    const next = m[2] !== undefined && nameWord(m[2]) ? m[2] : undefined
    // "-jun oYon": hiding the word "jun" would also hide the month in "Jun 11" (and restore the wrong text
    // there), so when the lowercase part is a month name only the word after it is hidden.
    if (MONTH.test(m[1])) {
      if (next) found.push({ text: next, category: 'PERSON' })
      continue
    }
    found.push({ text: next ? `${m[1]} ${next}` : m[1], category: 'PERSON' })
  }
  return found
}

/**
 * Hides everything the rules and keyword lists can find in already-redacted text, on top of Nano's work.
 * `allow` drops entities the settings say must stay visible (redact_salary=false).
 */
export function safetyNet(
  text: string,
  map: PlaceholderMap,
  allow: (entity: Entity) => boolean = () => true,
): { text: string; map: PlaceholderMap; added: number } {
  const entities = [...ruleEntities(text), ...medicalTerms(text), ...groupPhrases(text), ...leftoverNameParts(text)].filter(allow)
  if (entities.length === 0) return { text, map, added: 0 }
  const before = Object.keys(map.originals).length
  const result = applyEntities(text, entities, map)
  return { ...result, added: Object.keys(result.map.originals).length - before }
}
