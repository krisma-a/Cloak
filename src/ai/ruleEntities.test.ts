// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { medicalTerms, ruleEntities } from './ruleEntities.ts'

test('turns rule matches into entities', () => {
  const found = ruleEntities(
    'Email maria@example.com, call (555) 201-7788, SSN 123-45-6789, EMP-40912, paid $68,500. ' +
      'Witness: the only woman on the night crew.',
  )
  assert.deepEqual(
    found.map((e) => e.category).sort(),
    ['EMAIL', 'EMPLOYEE_ID', 'OTHER_ID', 'PHONE', 'ROLE', 'SALARY'],
  )
})

test('finds common medical terms but not work restrictions', () => {
  const found = medicalTerms(
    'She has type 2 diabetes and anxiety, and needs a short break every 2 hours.',
  ).map((e) => e.text)
  assert.deepEqual(found, ['type 2 diabetes', 'anxiety'])
})

test('medical terms match whole words only', () => {
  assert.deepEqual(medicalTerms('He works in aidstation logistics.'), [])
  assert.deepEqual(medicalTerms('Diagnosed with HIV.').map((e) => e.text), ['HIV'])
})

// Cases from the photo tests (fake documents), as OCR read them. FAKE DATA ONLY.
import { applyEntities as hideAll } from './placeholders.ts'
const hidden = (text: string) => hideAll(text, [...ruleEntities(text), ...medicalTerms(text)]).text

test('OCR misspellings and cut-off words are still hidden: medical words, phones, letter-prefixed IDs', () => {
  assert.equal(hidden('she has been managing type 2 diabet rivals'), 'she has been managing [MEDICAL_DETAIL_1] rivals')
  assert.equal(hidden('Complainant phone805) 555-0163'), 'Complainant phone[PHONE_1]')
  assert.equal(hidden('Call (805)555-0163 today'), 'Call [PHONE_1] today')
  assert.equal(hidden('Employee ID BSL-5560'), 'Employee ID [ID_1]')
  assert.equal(hidden('employee #SR-11407'), 'employee [ID_1]')
  assert.equal(hidden('Employee ID PCH-30981'), 'Employee ID [ID_1]')
  assert.equal(hidden('badge NG-77304 issued'), 'badge [ID_1] issued')
  assert.equal(hidden('Started sertral 50mg'), 'Started [MEDICAL_DETAIL_1] 50mg')
  assert.equal(hidden('Has migrianes weekly'), 'Has [MEDICAL_DETAIL_1] weekly')
})

test('no over-matching: weights, weekdays, day counts, percentages, times and everyday look-alike words stay', () => {
  for (const text of [
    'No lifting over 15 lbs',
    'Mon, Nov 16',
    'a 60-day PIP',
    'averaged 71%',
    '6:40 AM',
    'She asked to cancel the shift after the strike.',
    'Staff seized the phone during the holiday surge.',
    'He smelled of alcohol; the migrant worker program; a hydro bill.',
    'Form I-9 and W-2 on file.',
  ]) {
    assert.equal(hidden(text), text, text)
  }
})
