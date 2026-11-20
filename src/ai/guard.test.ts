// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmNoNames, hideNames, redactionBlockReason, sendBlockReason, splitNames } from './guard.ts'
import { applyEntities } from './placeholders.ts'
import type { RedactionResult } from './redact.ts'

const note = 'Maria Santos reported that Chidi Okafor mocked her. Later, Maria left. Salary: $68,500.'

// What the rules-only engine gives: the salary is hidden, the names are not.
function rulesOnly(): RedactionResult {
  const { text, map } = applyEntities(note, [{ text: '$68,500', category: 'SALARY' }])
  return {
    status: 'ok',
    engine: 'rules-only',
    needsCarefulReview: true,
    names: 'unchecked',
    redactedText: text,
    map,
    leaks: [],
    attempts: 1,
    ranOn: 'rules',
    counts: { SALARY: 1 },
  }
}

test('blocks sending while names are unchecked', () => {
  const r = rulesOnly()
  assert.match(sendBlockReason(r, true) ?? '', /names have not been checked/)
  assert.match(redactionBlockReason(r) ?? '', /names have not been checked/)
})

test('allows sending once a name model has checked', () => {
  assert.equal(sendBlockReason({ ...rulesOnly(), names: 'model' }, true), null)
})

test('still needs approval and an ok status', () => {
  assert.match(sendBlockReason({ ...rulesOnly(), names: 'model' }, false) ?? '', /not approved/)
  assert.match(sendBlockReason({ ...rulesOnly(), names: 'model', status: 'blocked' }, true) ?? '', /blocked/)
})

test('splits a typed list of names', () => {
  assert.deepEqual(splitNames('Maria Santos, Chidi Okafor;\nMaria Santos,  x '), ['Maria Santos', 'Chidi Okafor'])
})

test('hiding the typed names clears the block and removes them from the text', () => {
  const r = hideNames(rulesOnly(), ['Maria Santos', 'Chidi Okafor'])
  assert.equal(r.names, 'user')
  assert.equal(r.status, 'ok')
  assert.equal(r.redactedText, '[EMPLOYEE_1] reported that [EMPLOYEE_2] mocked her. Later, [EMPLOYEE_1] left. Salary: [SALARY_1].')
  assert.equal(sendBlockReason(r, true), null)
})

test('a name the user forgot to list stays visible (so they must confirm)', () => {
  const r = hideNames(rulesOnly(), ['Maria Santos'])
  assert.ok(r.redactedText.includes('Chidi Okafor'))
  assert.equal(r.names, 'user')
})

test('confirming there are no names unblocks without changing the text', () => {
  const before = rulesOnly()
  const after = confirmNoNames(before)
  assert.equal(after.redactedText, before.redactedText)
  assert.equal(sendBlockReason(after, true), null)
})
