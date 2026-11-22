// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEntities, restore } from './placeholders.ts'
import { buildDraftPrompt, checkDraft, TEMPLATES } from './templates.ts'

const { text: redacted, map } = applyEntities(
  'Maria Santos has type 2 diabetes and needs a break every 2 hours. Salary $68,500.',
  [
    { text: 'Maria Santos', category: 'PERSON' },
    { text: 'type 2 diabetes', category: 'MEDICAL' },
    { text: '$68,500', category: 'SALARY' },
  ],
)

test('the prompt contains only redacted text', () => {
  const prompt = buildDraftPrompt(redacted, 'accommodation')
  assert.ok(prompt.includes('[EMPLOYEE_1]'))
  assert.ok(!prompt.includes('Maria'))
  assert.ok(!prompt.includes('diabetes'))
})

test('manager emails never get a diagnosis back', () => {
  const draft = 'Hi, [EMPLOYEE_1] has [MEDICAL_DETAIL_1] and needs a break every 2 hours.'
  const checked = checkDraft(draft, map, 'accommodation')
  const final = restore(checked.text, map, ['MEDICAL_DETAIL', 'DOB', 'SALARY', 'ID'])
  assert.equal(final, 'Hi, Maria Santos has [withheld] and needs a break every 2 hours.')
  assert.match(checked.warnings.join(' '), /Withheld 1 MEDICAL/)
})

test('HR file drafts restore everything except health details', () => {
  const draft = '[EMPLOYEE_1] reported [MEDICAL_DETAIL_1] and [Medical Detail 1]; salary [SALARY_1].'
  const checked = checkDraft(draft, map, 'investigation')
  assert.match(checked.warnings.join(' '), /Withheld 2 MEDICAL_DETAIL detail\(s\): not allowed in an HR file draft/)
  assert.equal(
    restore(checked.text, map, TEMPLATES.investigation.withhold),
    'Maria Santos reported [withheld] and [withheld]; salary $68,500.',
  )
})

test('manager emails withhold a diagnosis even if the model reformats the placeholder', () => {
  const draft = 'Hi, [employee 1] has [ Medical-Detail_01 ] and needs a break.'
  const checked = checkDraft(draft, map, 'accommodation')
  assert.match(checked.warnings.join(' '), /Withheld 1 MEDICAL/)
  assert.equal(
    restore(checked.text, map, ['MEDICAL_DETAIL', 'DOB', 'SALARY', 'ID']),
    'Hi, Maria Santos has [withheld] and needs a break.',
  )
})

test('does not flag ordinary bracketed text as invented placeholders', () => {
  const checked = checkDraft('See [Table 1] and [EMPLOYEE 1].', map, 'investigation')
  assert.deepEqual(checked.warnings, [])
})

test('reports placeholders the model invented', () => {
  const checked = checkDraft('Witness [EMPLOYEE_7] agreed.', map, 'investigation')
  assert.match(checked.warnings.join(' '), /\[EMPLOYEE_7\]/)
})
