// Entity finders that need no AI model. Used by the backup redaction path (browsers without
// Gemini Nano). Pure functions (no Firebase), so tests run in Node.

import { findLeaks, type LeakCategory } from '../rules/rules.ts'
import type { Category, Entity } from './placeholders.ts'

// What each fixed-shape rule match should be hidden as.
const RULE_TO_CATEGORY: Partial<Record<LeakCategory, Category>> = {
  SSN: 'OTHER_ID',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  DATE: 'DATE_OF_BIRTH',
  SALARY: 'SALARY',
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
]
const MEDICAL = new RegExp(`(?<![\\p{L}\\p{N}])(?:${MEDICAL_TERMS.join('|')})(?![\\p{L}\\p{N}])`, 'giu')

/** Finds common diagnoses, conditions and treatments by keyword. */
export function medicalTerms(text: string): Entity[] {
  return [...text.matchAll(MEDICAL)].map((m) => ({ text: m[0], category: 'MEDICAL' as const }))
}
