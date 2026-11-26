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
  | 'AGE'
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
  // (555) 201-7788, 555-201-7788, 555.201.7788, +1 555 201 7788, +63 917 123 4567. OCR drops a bracket and glues
  // the number to the word before it, so "phone805) 555-0163" and "(805)555-0163" count too. Never inside a longer
  // run of digits.
  {
    category: 'PHONE',
    regex: /(?:\+\d{1,3}[\s.-]?)?(?<!\d)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g,
  },
  // Full dates with a 4-digit year (likely birth dates): 03/14/1988, 14-03-1988, 1988-03-14.
  // Dates without a year ("Oct 3") are allowed because case timelines need them.
  {
    category: 'DATE',
    regex: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}|(?:19|20)\d{2}-\d{1,2}-\d{1,2})\b/g,
  },
  // $68,500  $68.5k  $85000/yr  USD 70,000  PHP 45,000  ₱45,000  ₹6 lakh  ₦420,000  INR 7 lakh
  {
    category: 'SALARY',
    regex: new RegExp(
      `(?:[$₱€£₹₦¥₩₫]\\s?|\\b(?:USD|PHP|EUR|GBP|INR|NGN|JPY|KRW|CAD|AUD|SGD|MXN|BRL|ZAR|AED|VND|CNY)\\s?)` +
        `\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:[kKmM]\\b|lakhs?\\b|crores?\\b|million\\b))?`,
      'g',
    ),
  },
  // Pay written without a currency sign: "62k", "131.5k", "72,000 a year", "24.50 an hour", "85k/yr".
  // A bare "62k" is money in HR notes far more often than anything else. Skipped right after a currency
  // sign, so "$68,500 a year" is one leak (the pattern above), not two.
  {
    category: 'SALARY',
    regex: /(?<![$₱€£₹₦¥₩₫]\s?)(?<![\d.,])\b(?:\d{2,3}(?:\.\d{1,2})?[kK]\b(?:\s?\/\s?(?:yr|year|mo|month))?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s(?:a|an|per)\s(?:year|month|hour|week)\b|\d{1,3}(?:\.\d{2})?\s?(?:\/\s?(?:hr|hour)|(?:an|per)\s(?:hour))\b)/g,
  },
  // Ages: "aged 36", "age 52", "23 years old", "a 41-year-old". Age is a protected trait (ADEA).
  {
    category: 'AGE',
    regex: /\b(?:aged?\s+\d{1,2}|\d{1,2}[\s-]years?[\s-]old)\b/gi,
  },
  // EMP-40912, EID 55120, ID#88231, E10293
  { category: 'EMPLOYEE_ID', regex: /\b(?:EMP|EID|ID|E)[-#: ]?\d{4,}\b/gi },
  // Letter-prefixed IDs: BSL-5560, PCH-30981, SR-11407, #NG-77304. Capitals only, so "a 60-day PIP" and "Mon" stay.
  { category: 'EMPLOYEE_ID', regex: /(?<![\p{L}\p{N}#])#?[A-Z]{2,4}-\d{4,6}(?!\d)/gu },
]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Matches a known string as a whole word, ignoring case ("Maria" does not match "Mariana"). A value that starts or
// ends with a digit may touch a letter on that side, because OCR glues numbers to words ("phone805) 555-0163"), but
// never another digit.
export function wholeWordRegex(s: string): RegExp {
  const before = /^\d/.test(s) ? '(?<!\\p{N})' : '(?<![\\p{L}\\p{N}])'
  const after = /\d$/.test(s) ? '(?!\\p{N})' : '(?![\\p{L}\\p{N}])'
  return new RegExp(`${before}${escapeRegex(s)}${after}`, 'giu')
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

  // Known strings are checked outside placeholders: "employee" is not a leak just because "[EMPLOYEE_1]" contains it.
  const outside = text.replace(/\[[A-Z]+(?:_[A-Z]+)*_\d+\]/g, (token) => ' '.repeat(token.length))
  for (const value of knownSensitive) {
    const trimmed = value.trim()
    if (trimmed.length < 2) continue
    const match = outside.match(wholeWordRegex(trimmed))
    if (match) add('KNOWN', match[0])
  }

  return leaks
}
