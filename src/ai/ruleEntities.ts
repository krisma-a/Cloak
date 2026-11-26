// Entity finders that need no AI model. Used by the backup redaction path (browsers without
// Gemini Nano). Pure functions (no Firebase), so tests run in Node.

import { editDistance } from '../rules/fuzzy.ts'
import { findLeaks, type LeakCategory } from '../rules/rules.ts'
import { maskPlaceholders, type Category, type Entity } from './placeholders.ts'

// What each fixed-shape rule match should be hidden as.
const RULE_TO_CATEGORY: Partial<Record<LeakCategory, Category>> = {
  SSN: 'OTHER_ID',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  DATE: 'DATE_OF_BIRTH',
  SALARY: 'SALARY',
  AGE: 'DATE_OF_BIRTH',
  EMPLOYEE_ID: 'EMPLOYEE_ID',
  INDIRECT: 'ROLE',
}

/** Turns every rules.ts match (SSN, email, phone, salary, "the only ..." etc.) into an entity. */
export function ruleEntities(text: string): Entity[] {
  return findLeaks(text).flatMap((leak) => {
    const category = RULE_TO_CATEGORY[leak.category]
    return category ? [{ text: leak.text, category }] : []
  })
}

// Common medical terms for the backup path. Not complete: the review step still matters.
// Work restrictions ("needs a break every 2 hours") are NOT medical and stay visible.
const MEDICAL_TERMS = [
  '(?:type [12] )?diabetes', 'diabetic', 'cancer', 'chemo(?:therapy)?', 'radiation therapy',
  'pregnan(?:t|cy)', 'miscarriage', 'ivf', 'depression', 'depressive disorder', 'anxiety',
  'panic attacks?', 'ptsd', 'bipolar(?: disorder)?', 'adhd', 'autism', 'epilepsy', 'seizures?',
  'hiv', 'aids', 'asthma', 'migraines?', 'arthritis', 'multiple sclerosis', 'lupus',
  "crohn'?s(?: disease)?", 'ibs', 'hypertension', 'high blood pressure', 'heart disease',
  'heart attack', 'stroke', 'surgery', 'dialysis', 'insulin', 'chronic pain', 'back injury',
  'carpal tunnel', 'long covid', 'covid-19', 'hearing loss', 'eating disorder',
  'substance use disorder', 'alcoholism', 'rehab', 'antidepressants?', 'schizophrenia', 'ocd',
  ...[
    'sertraline', 'fluoxetine', 'escitalopram', 'citalopram', 'bupropion', 'metformin', 'lisinopril', 'prednisone',
    'gabapentin', 'adderall', 'xanax', 'zoloft', 'prozac', 'lexapro', 'wellbutrin', 'oxycodone', 'hydrocodone',
    'methotrexate', 'levothyroxine', 'atorvastatin', 'amlodipine', 'ozempic',
  ], // common medications
]
const MEDICAL = new RegExp(`(?<![\\p{L}\\p{N}])(?:${MEDICAL_TERMS.join('|')})(?![\\p{L}\\p{N}])`, 'giu')

// One-word terms OCR may misspell or cut short ("diabet", "sertral", "migrianes"). Whole words only.
const FUZZY_TERMS = [
  'diabetes', 'diabetic', 'cancer', 'chemotherapy', 'pregnant', 'pregnancy', 'miscarriage', 'depression', 'anxiety',
  'epilepsy', 'seizure', 'seizures', 'asthma', 'migraine', 'migraines', 'arthritis', 'sclerosis', 'hypertension',
  'dialysis', 'insulin', 'schizophrenia', 'alcoholism', 'antidepressant', 'antidepressants', 'autism', 'bipolar',
  'surgery', 'stroke', 'sertraline', 'fluoxetine', 'escitalopram', 'citalopram', 'bupropion', 'metformin',
  'lisinopril', 'prednisone', 'gabapentin', 'adderall', 'wellbutrin', 'oxycodone', 'hydrocodone', 'methotrexate',
  'levothyroxine', 'atorvastatin', 'amlodipine', 'chemo', 'lupus', 'xanax', 'zoloft', 'prozac', 'lexapro', 'ozempic',
]
// Everyday words one or two letters from a term, or the start of one. Never medical on their own.
const NOT_MEDICAL = new Set([
  'cancel', 'cancels', 'canceled', 'dancer', 'canter', 'strike', 'strikes', 'stoke', 'stokes', 'migrate', 'migrated',
  'migrates', 'migrant', 'migrants', 'surge', 'surges', 'hyper', 'alcohol', 'seize', 'seized', 'seizes', 'hydro',
  'depressing', 'insult', 'insults', 'method', 'methods',
])
const TYPE_BEFORE = /type\s+[12]\s+$/i

/**
 * A term `word` (lower case) is an OCR misspelling or a cut-off start of, or undefined: the start of a term (5+
 * letters), or 1 typo away (2 for terms of 8+ letters) for terms of 6+ letters, keeping the first letter.
 */
function fuzzyTerm(word: string): string | undefined {
  if (word.length < 5 || NOT_MEDICAL.has(word)) return undefined
  for (const term of FUZZY_TERMS) {
    if (term === word) return term
    if (term.length > word.length && term.startsWith(word)) return term
    if (term.length < 6 || term[0] !== word[0]) continue
    const budget = term.length >= 8 ? 2 : 1
    if (editDistance(word, term, budget) <= budget) return term
  }
  return undefined
}

/**
 * Finds common diagnoses, conditions, treatments and medications by keyword, including OCR misspellings and cut-off
 * words ("type 2 diabet"). Whole words only.
 */
export function medicalTerms(text: string): Entity[] {
  const exact = [...text.matchAll(MEDICAL)]
  const found = exact.map((m) => ({ text: m[0], category: 'MEDICAL' as const }))
  const inExact = (at: number) => exact.some((m) => at >= m.index && at < m.index + m[0].length)
  const masked = maskPlaceholders(text)
  for (const m of masked.matchAll(/(?<![\p{L}\p{N}])\p{L}+(?![\p{L}\p{N}])/gu)) {
    if (inExact(m.index) || !fuzzyTerm(m[0].toLowerCase())) continue
    const type = TYPE_BEFORE.exec(masked.slice(Math.max(0, m.index - 10), m.index))
    found.push({ text: type ? `${type[0]}${m[0]}` : m[0], category: 'MEDICAL' as const })
  }
  return found
}
