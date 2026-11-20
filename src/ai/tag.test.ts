// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCaseType } from './caseType.ts'

test('reads the case type from the model reply', () => {
  assert.equal(parseCaseType('Investigation'), 'Investigation')
  assert.equal(parseCaseType('accommodation.'), 'Accommodation')
  assert.equal(parseCaseType('This looks like a TERMINATION case'), 'Termination')
  assert.equal(parseCaseType('unclear'), null)
})
