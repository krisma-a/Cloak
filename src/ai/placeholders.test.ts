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
    '[EMPLOYEE_1] met [EMPLOYEE_2]. Later, [EMPLOYEE_1] emailed [EMAIL_1] about [MEDICAL_DETAIL_1].',
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
    restore('Dear [EMPLOYEE_1], re: [MEDICAL_DETAIL_1].', map),
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
    restore('[employee 1] told [EMPLOYEE_2] about [ Medical Detail 1 ] and [email-1].', map),
    'Maria Santos told Chidi Okafor about diabetes and maria@example.com.',
  )
})

test('multi-word prefixes come back in any spacing, and withholding still catches them', () => {
  const { map } = applyEntities('Arjun said his son\'s autism diagnosis hurts. Arjun has migraines.', [
    { text: 'Arjun', category: 'PERSON' },
    { text: "his son's autism diagnosis", category: 'FAMILY_MEDICAL' },
    { text: 'migraines', category: 'MEDICAL' },
  ])
  const draft = '[Family Medical 1] / [family-medical_1] / [Medical Detail 1] / [MEDICAL DETAIL_01] / \\[MEDICAL\\_DETAIL\\_1\\]'
  assert.equal(
    restore(draft, map, ['FAMILY_MEDICAL', 'MEDICAL_DETAIL']),
    '[withheld] / [withheld] / [withheld] / [withheld] / [withheld]',
  )
  assert.equal(restore('Re: [Medical Detail 1]', map), 'Re: migraines')
  assert.equal(restore('[Medical Detail 9] [Medical Report 1]', map), '[Medical Detail 9] [Medical Report 1]')
})

test('leaves look-alikes and unknown placeholders alone', () => {
  const { map } = applyEntities(note, entities)
  const text = 'See [Table 1] and [Note 2]. Witness [EMPLOYEE_9] and [pet 1] agreed.'
  assert.equal(restore(text, map), text)
})

test('withholds reformatted placeholders too', () => {
  const { map } = applyEntities(note, entities)
  assert.equal(
    restore('Re: [medical detail 1], [ MEDICAL_DETAIL_01 ], [MEDICAL_DETAIL_1].', map, ['MEDICAL_DETAIL']),
    'Re: [withheld], [withheld], [withheld].',
  )
})

test('restoring never changes the map', () => {
  const { map } = applyEntities(note, entities)
  const before = structuredClone(map)
  restore('[EMPLOYEE_1] [employee 2] [MEDICAL_DETAIL_1]', map, ['MEDICAL_DETAIL'])
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

test('restores a team in the note\'s own words (no added "the", same capitals)', () => {
  const note = 'Joy is the only woman on the night warehouse crew. Night warehouse crew leads say she trained everyone.'
  const { text, map } = applyEntities(note, [
    { text: 'Joy', category: 'PERSON' },
    { text: 'the only woman on the night warehouse crew', category: 'ROLE' },
  ])
  assert.equal(text, '[EMPLOYEE_1] is [ROLE_1] on the [DEPT_1]. [DEPT_1] leads say she trained everyone.')
  assert.equal(restore(text, map), note)
})

test('a phrase is capitalized only where a sentence, line or bullet starts', () => {
  const { map } = applyEntities('The only contractor was sent home.', [{ text: 'The only contractor', category: 'ROLE' }])
  assert.equal(map.originals['[ROLE_1]'], 'the only contractor')
  assert.equal(
    restore('HR spoke with [ROLE_1]. [ROLE_1] agreed.\n- [ROLE_1] signed.', map),
    'HR spoke with the only contractor. The only contractor agreed.\n- The only contractor signed.',
  )
})

test('a one-word team keeps its article, so the same word elsewhere stays visible', () => {
  const { text } = applyEntities('She works in the warehouse. Every warehouse has a first-aid kit.', [
    { text: 'the warehouse', category: 'DEPARTMENT' },
  ])
  assert.equal(text, 'She works in [DEPT_1]. Every warehouse has a first-aid kit.')
})

test('counts placeholders by type without content', () => {
  const { map } = applyEntities(note, entities)
  assert.deepEqual(countByPrefix(map), { EMPLOYEE: 2, EMAIL: 1, MEDICAL_DETAIL: 1 })
})
