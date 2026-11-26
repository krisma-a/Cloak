import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findLeaks } from '../rules/rules.ts'
import { hideNameParts, nameParts } from './nameParts.ts'
import { applyEntities, sensitiveStrings, type Entity } from './placeholders.ts'

// FAKE DATA ONLY: made-up names.

/** What the redaction does with found names: applyEntities, then every other spelling of their parts. */
function hide(text: string, entities: Entity[]) {
  const applied = applyEntities(text, entities)
  return hideNameParts(applied.text, applied.map)
}

test('"Signed: Hernandez" is hidden as the same person once "Luis Hernandez" was found earlier in the note', () => {
  const { text } = hide('Met with Luis Hernandez on Monday.\nSigned: Hernandez', [{ text: 'Luis Hernandez', category: 'PERSON' }])
  assert.equal(text, 'Met with [EMPLOYEE_1] on Monday.\nSigned: [EMPLOYEE_1]')
})

test('an OCR misspelling of a found name ("whitield") is hidden with the same placeholder, and joins the leak check', () => {
  const { text, map, added } = hide('James Whitfield reported it.\nCase 2 whitield Depart', [{ text: 'James Whitfield', category: 'PERSON' }])
  assert.equal(text, '[EMPLOYEE_1] reported it.\nCase 2 [EMPLOYEE_1] Depart')
  assert.equal(added, 1)
  assert.equal(map.lookup.whitield, '[EMPLOYEE_1]')
  assert.deepEqual(findLeaks('whitield said hi', sensitiveStrings(map)).map((l) => l.category), ['KNOWN'])
})

test('two people keep their own placeholders, and a capitalised typo is caught for short names too', () => {
  const { text } = hide('Dan Reyes and Ana Price met. Later Reyez and Prlce spoke.', [
    { text: 'Dan Reyes', category: 'PERSON' },
    { text: 'Ana Price', category: 'PERSON' },
  ])
  assert.equal(text, '[EMPLOYEE_1] and [EMPLOYEE_2] met. Later [EMPLOYEE_1] and [EMPLOYEE_2] spoke.')
})

test('ordinary words near a name stay: "eyes" is not Reyes, lowercase "price" is not Price, titles are never parts', () => {
  const { text } = hide('Dr. Dan Reyes checked her eyes. The price went up. Dr. Kim agreed.', [
    { text: 'Dr. Dan Reyes', category: 'PERSON' },
  ])
  assert.equal(text, '[EMPLOYEE_1] checked her eyes. The price went up. Dr. Kim agreed.')
  assert.ok(!nameParts(applyEntities('Dr. Dan Reyes', [{ text: 'Dr. Dan Reyes', category: 'PERSON' }]).map).has('dr'))
})

test('a hyphenated first name does not hide the month ("Min-jun" vs "Jun 11")', () => {
  const { text } = hide('Min-jun Park filed it on Jun 11.', [{ text: 'Min-jun Park', category: 'PERSON' }])
  assert.equal(text, '[EMPLOYEE_1] filed it on Jun 11.')
})
