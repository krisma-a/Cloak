// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEntities,
  countByPrefix,
  filterEntities,
  restore,
  type Entity,
} from './placeholders.ts'

const note = 'Maria Santos met Chidi Okafor. Later, Maria emailed maria@example.com about diabetes.'
const entities: Entity[] = [
  { text: 'Maria Santos', category: 'PERSON' },
  { text: 'Chidi Okafor', category: 'PERSON' },
  { text: 'maria@example.com', category: 'EMAIL' },
  { text: 'diabetes', category: 'MEDICAL' },
]

test('replaces entities with consistent placeholders', () => {
  const { text } = applyEntities(note, entities)
  assert.equal(
    text,
    '[EMPLOYEE_1] met [EMPLOYEE_2]. Later, [EMPLOYEE_1] emailed [EMAIL_1] about [MEDICAL_1].',
  )
})

test('ignores entities the model invented', () => {
  const { text, map } = applyEntities('Hello Maria.', [{ text: 'Juan Dela Cruz', category: 'PERSON' }])
  assert.equal(text, 'Hello Maria.')
  assert.deepEqual(map.originals, {})
})

test('keeps placeholders when called again with more entities', () => {
  const first = applyEntities(note, entities.slice(0, 1))
  const second = applyEntities(first.text, entities.slice(1), first.map)
  assert.match(second.text, /^\[EMPLOYEE_1\] met \[EMPLOYEE_2\]/)
})

test('restores originals', () => {
  const { map } = applyEntities(note, entities)
  assert.equal(
    restore('Dear [EMPLOYEE_1], re: [MEDICAL_1].', map),
    'Dear Maria Santos, re: diabetes.',
  )
})

test('restores a placeholder every time it appears', () => {
  const { map } = applyEntities(note, entities)
  assert.equal(
    restore('[EMPLOYEE_1] spoke. Later [EMPLOYEE_1] left; [EMPLOYEE_1]’s manager agreed.', map),
    'Maria Santos spoke. Later Maria Santos left; Maria Santos’s manager agreed.',
  )
})

test('restores placeholders the model reformatted', () => {
  const { map } = applyEntities(note, entities)
  const variants = [
    '[employee_1]',
    '[Employee_1]',
    '[ EMPLOYEE_1 ]',
    '[EMPLOYEE 1]',
    '[EMPLOYEE-1]',
    '[EMPLOYEE_01]',
    '\\[EMPLOYEE\\_1\\]', // markdown-escaped
    '**[EMPLOYEE_1]**',
  ]
  for (const variant of variants) {
    assert.equal(restore(`Dear ${variant}.`, map).replace(/\*/g, ''), 'Dear Maria Santos.', variant)
  }
  // Several different placeholders, mixed formats, in one draft.
  assert.equal(
    restore('[employee 1] told [EMPLOYEE_2] about [ Medical_1 ] and [email-1].', map),
    'Maria Santos told Chidi Okafor about diabetes and maria@example.com.',
  )
})

test('leaves look-alikes and unknown placeholders alone', () => {
  const { map } = applyEntities(note, entities)
  const text = 'See [Table 1] and [Note 2]. Witness [EMPLOYEE_9] and [pet 1] agreed.'
  assert.equal(restore(text, map), text)
})

test('withholds reformatted placeholders too', () => {
  const { map } = applyEntities(note, entities)
  assert.equal(
    restore('Re: [medical 1], [ MEDICAL_01 ], [MEDICAL_1].', map, ['MEDICAL']),
    'Re: [withheld], [withheld], [withheld].',
  )
})

test('restoring never changes the map', () => {
  const { map } = applyEntities(note, entities)
  const before = structuredClone(map)
  restore('[EMPLOYEE_1] [employee 2] [MEDICAL_1]', map, ['MEDICAL'])
  assert.deepEqual(map, before)
})

test('stores the note’s own casing, not the model’s', () => {
  const { map } = applyEntities('Hi Maria Santos.', [{ text: 'maria santos', category: 'PERSON' }])
  assert.equal(map.originals['[EMPLOYEE_1]'], 'Maria Santos')
})

test('keeps event dates visible but hides real birth dates', () => {
  const dob = (text: string, value: string) =>
    filterEntities(text, [{ text: value, category: 'DATE_OF_BIRTH' }]).length === 1
  assert.equal(dob('mocked her in the Oct 3 team meeting', 'Oct 3'), false)
  assert.equal(dob('She was born Oct 3, 1990.', 'Oct 3, 1990'), true)
  assert.equal(dob('DOB: Oct 3', 'Oct 3'), true)
  assert.equal(dob('He is 54 years old.', '54 years old'), true)

  const { text } = applyEntities('In the Oct 3 meeting.', [{ text: 'oct 3', category: 'DATE_OF_BIRTH' }])
  assert.equal(text, 'In the Oct 3 meeting.')
})

test('keeps events visible but hides real team names', () => {
  const dept = (value: string) =>
    filterEntities(`in the ${value}`, [{ text: value, category: 'DEPARTMENT' }]).length === 1
  assert.equal(dept('Oct 3 team meeting'), false)
  assert.equal(dept('weekly safety huddle'), false)
  assert.equal(dept('night warehouse crew'), true)
  assert.equal(dept('Cebu branch'), true)
})

test('counts placeholders by type without content', () => {
  const { map } = applyEntities(note, entities)
  assert.deepEqual(countByPrefix(map), { EMPLOYEE: 2, EMAIL: 1, MEDICAL: 1 })
})
