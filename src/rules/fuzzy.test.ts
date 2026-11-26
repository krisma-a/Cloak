import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeEnough, editDistance, typoBudget } from './fuzzy.ts'

test('typo budget: none up to 3 letters, 1 for 4-6, 2 for 7+', () => {
  assert.deepEqual([3, 4, 6, 7, 12].map(typoBudget), [0, 1, 1, 2, 2])
})

test('edit distance counts inserts, deletes and changes, and stops early past the limit', () => {
  assert.equal(editDistance('whitfield', 'whitield'), 1)
  assert.equal(editDistance('kitten', 'sitting'), 3)
  assert.equal(editDistance('abc', 'abcdefgh', 2), 3)
  assert.ok(closeEnough('whitield', 'whitfield'))
  assert.ok(closeEnough('reyez', 'reyes'))
  assert.ok(!closeEnough('dam', 'dan'), 'three letters must match exactly')
})
