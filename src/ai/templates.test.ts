// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEntities, restore } from './placeholders.ts'
import { buildDraftPrompt, checkDraft } from './templates.ts'

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
  const draft = 'Hi, [EMPLOYEE_1] has [MEDICAL_1] and needs a break every 2 hours.'
  const checked = checkDraft(draft, map, 'accommodation')
  const final = restore(checked.text, map, ['MEDICAL', 'DOB', 'SALARY', 'ID'])
  assert.equal(final, 'Hi, Maria Santos has [withheld] and needs a break every 2 hours.')
  assert.match(checked.warnings.join(' '), /Withheld 1 MEDICAL/)
})

test('HR file drafts restore everything', () => {
  const draft = '[EMPLOYEE_1] reported [MEDICAL_1]; salary [SALARY_1].'
  assert.deepEqual(checkDraft(draft, map, 'investigation').warnings, [])
  assert.equal(restore(draft, map), 'Maria Santos reported type 2 diabetes; salary $68,500.')
})

test('reports placeholders the model invented', () => {
  const checked = checkDraft('Witness [EMPLOYEE_7] agreed.', map, 'investigation')
  assert.match(checked.warnings.join(' '), /\[EMPLOYEE_7\]/)
})
