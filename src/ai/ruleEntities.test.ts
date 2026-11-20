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
