// Fixed leak checks that run on text AFTER the model has redacted it.
// No model is trusted alone: if anything here still matches, the text is not safe to send.
// Shared by the app and the eval page. Pure functions only (no Firebase), so tests run in Node.
// One setting changes what counts as a leak: redact_salary=false (Remote Config, see policy.ts)
// lets pay amounts stay visible. Everything else is always checked.

import { getPolicy } from '../policy.ts'

export type LeakCategory =
  | 'SSN'
  | 'EMAIL'
  | 'PHONE'
  | 'DATE'
  | 'SALARY'
  | 'EMPLOYEE_ID'
  | 'INDIRECT'
  | 'KNOWN'

export interface Leak {
  category: LeakCategory
  text: string
}

// Words for people, used to spot phrases that single someone out.
const PEOPLE =
  '(?:woman|women|man|men|person|people|employee|worker|staff(?:er)?|member|lady|girl|guy|' +
  'mother|mom|father|dad|parent|veteran|hire|nurse|driver|engineer|developer|manager|' +
  'supervisor|associate|technician|agent|intern|contractor|cashier|teacher|doctor|immigrant)'

// Indirect identifiers: "the only woman on the night warehouse crew",
// "the only Filipino nurse in the ICU", "the youngest engineer".
// A match that already contains a placeholder ("the only woman on [DEPT_1]") is skipped,
// because the cloud can't tell who that is without the hidden part.
const INDIRECT = new RegExp(
  `\\b(?:the|a|an)\\s+(?:only|sole|lone|youngest|oldest|newest)\\s+(?:[\\p{L}-]+\\s+){0,3}?${PEOPLE}\\b` +
    `(?:\\s+(?:on|in|at|from|of|with|who)\\s+[^.,;:()!?\\n]{2,60})?`,
  'giu',
)

// Patterns for identifiers that have a fixed shape. Placeholders like [SALARY_1] never match.
const PATTERNS: Array<{ category: LeakCategory; regex: RegExp }> = [
  { category: 'INDIRECT', regex: INDIRECT },
  // 123-45-6789 or 123 45 6789
  { category: 'SSN', regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  { category: 'EMAIL', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // (555) 201-7788, 555-201-7788, 555.201.7788, +1 555 201 7788, +63 917 123 4567
  {
    category: 'PHONE',
    regex: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
  // Full dates with a 4-digit year (likely birth dates): 03/14/1988, 14-03-1988, 1988-03-14.
  // Dates without a year ("Oct 3") are allowed because case timelines need them.
  {
    category: 'DATE',
    regex: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}|(?:19|20)\d{2}-\d{1,2}-\d{1,2})\b/g,
  },
  // $68,500  $68.5k  $85000/yr  USD 70,000  PHP 45,000  ₱45,000
  {
    category: 'SALARY',
    regex: /(?:[$₱€£]\s?\d[\d,]*(?:\.\d+)?\s?[kK]?|\b(?:USD|PHP|EUR|GBP)\s?\d[\d,]*(?:\.\d+)?\s?[kK]?)/g,
  },
  // EMP-40912, EID 55120, ID#88231, E10293
  { category: 'EMPLOYEE_ID', regex: /\b(?:EMP|EID|ID|E)[-#: ]?\d{4,}\b/gi },
]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Matches a known string as a whole word, ignoring case ("Maria" does not match "Mariana").
export function wholeWordRegex(s: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(s)}(?![\\p{L}\\p{N}])`, 'giu')
}

/**
 * Returns every leak found in `text`.
 * @param knownSensitive strings that must not appear, e.g. names the model already found.
 * @param options `ignorePolicy` checks everything, even when redact_salary is off (for text that
 *   must never contain money, such as a work restriction).
 */
export function findLeaks(
  text: string,
  knownSensitive: string[] = [],
  options: { ignorePolicy?: boolean } = {},
): Leak[] {
  const allowSalary = !options.ignorePolicy && !getPolicy().redact_salary
  const leaks: Leak[] = []
  const seen = new Set<string>()
  const add = (category: LeakCategory, value: string) => {
    const key = `${category}:${value.toLowerCase()}`
    if (!seen.has(key)) {
      seen.add(key)
      leaks.push({ category, text: value })
    }
  }

  for (const { category, regex } of PATTERNS) {
    if (allowSalary && category === 'SALARY') continue
    for (const match of text.matchAll(regex)) {
      if (match[0].includes('[')) continue // already partly hidden by a placeholder
      add(category, match[0].trim())
    }
  }

  for (const value of knownSensitive) {
    const trimmed = value.trim()
    if (trimmed.length < 2) continue
    const match = text.match(wholeWordRegex(trimmed))
    if (match) add('KNOWN', match[0])
  }

  return leaks
}
