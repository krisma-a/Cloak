// Run with: npm test   (fake data only)
// Indirect identifiers: each case feeds a Nano-shaped JSON reply through the same code the app
// runs (parseEntities -> applyEntities -> leak re-check). These test our side of the pipeline;
// whether Nano itself finds the phrases can only be measured in Chrome with the real model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLeaks } from '../rules/rules.ts'
import { applyEntities, countByPrefix, restore, sensitiveStrings, type Category } from './placeholders.ts'
import { buildPrompt, ENTITY_SCHEMA, INSTRUCTIONS, parseEntities } from './redactPrompt.ts'
import { checkDraft, TEMPLATES } from './templates.ts'

/** Builds the JSON Nano would return, then redacts the note with it. */
function run(note: string, found: Array<[string, Category]>) {
  const reply = JSON.stringify({ entities: found.map(([text, category]) => ({ text, category })) })
  const { text, map } = applyEntities(note, parseEntities(reply))
  return { text, map, counts: countByPrefix(map), leaks: findLeaks(text, sensitiveStrings(map)) }
}

// --- Unique role + team ----------------------------------------------------------------------

test('1. unique role and its site become [ROLE_1] in the [DEPT_1]', () => {
  const r = run('Rosa Dela Cruz is the only night-shift forklift lead in the Reno warehouse.', [
    ['Rosa Dela Cruz', 'PERSON'],
    ['the only night-shift forklift lead', 'ROLE'],
    ['the Reno warehouse', 'DEPARTMENT'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] is [ROLE_1] in the [DEPT_1].')
  assert.deepEqual(r.leaks, [])
})

test('2. "only person of a group" sent as one phrase is still split into role and team', () => {
  const r = run('Ngozi is the only woman on the night warehouse crew.', [
    ['Ngozi', 'PERSON'],
    ['the only woman on the night warehouse crew', 'ROLE'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] is [ROLE_1] on the [DEPT_1].')
  assert.deepEqual(r.leaks, [])
})

test('3. whole phrase plus its team from the model gives one DEPT, not two', () => {
  const r = run('Thanh, the only Vietnamese nurse in the ICU, filed the complaint.', [
    ['Thanh', 'PERSON'],
    ['the only Vietnamese nurse in the ICU', 'ROLE'],
    ['the ICU', 'DEPARTMENT'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1], [ROLE_1] in the [DEPT_1], filed the complaint.')
  assert.deepEqual(r.counts, { EMPLOYEE: 1, ROLE: 1, DEPT: 1 })
})

test('4. the team named again without "the" gets the same placeholder', () => {
  const r = run('Luis is the sole payroll analyst at the Cebu branch. Cebu branch staff report to him.', [
    ['Luis', 'PERSON'],
    ['the sole payroll analyst', 'ROLE'],
    ['the Cebu branch', 'DEPARTMENT'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] is [ROLE_1] at the [DEPT_1]. [DEPT_1] staff report to him.')
  assert.deepEqual(r.leaks, [])
  assert.equal(restore(r.text, r.map), 'Luis is the sole payroll analyst at the Cebu branch. Cebu branch staff report to him.')
})

test('5. a role mentioned twice keeps one placeholder', () => {
  const r = run('Amaka is the youngest engineer in Platform. Leads keep asking the youngest engineer to cover nights.', [
    ['Amaka', 'PERSON'],
    ['the youngest engineer', 'ROLE'],
    ['Platform', 'DEPARTMENT'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] is [ROLE_1] in [DEPT_1]. Leads keep asking [ROLE_1] to cover nights.')
  assert.deepEqual(r.counts, { EMPLOYEE: 1, ROLE: 1, DEPT: 1 })
})

test('6. a title only one person holds is hidden with its site', () => {
  const r = run('The plant manager at the Tulsa site approved the schedule.', [
    ['The plant manager at the Tulsa site', 'ROLE'],
  ])
  assert.equal(r.text, '[ROLE_1] at the [DEPT_1] approved the schedule.')
  assert.equal(restore(r.text, r.map), 'The plant manager at the Tulsa site approved the schedule.')
})

// --- Rare tenure + team ----------------------------------------------------------------------

test('7. rare tenure and its department become [TENURE_1] in [DEPT_1]', () => {
  const r = run('Priya Raman, a 28-year veteran in Treasury, disputes the write-up.', [
    ['Priya Raman', 'PERSON'],
    ['28-year veteran', 'TENURE'],
    ['Treasury', 'DEPARTMENT'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1], a [TENURE_1] in [DEPT_1], disputes the write-up.')
  assert.deepEqual(r.leaks, [])
})

test('8. tenure sent as one phrase with its team is split too', () => {
  const r = run('Chidi is the longest-serving driver at the Lagos depot.', [
    ['Chidi', 'PERSON'],
    ['the longest-serving driver at the Lagos depot', 'TENURE'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] is [TENURE_1] at the [DEPT_1].')
})

test('9. a start year is not mistaken for a team, and "member of" stays one phrase', () => {
  const r = run('Mei was hired in 1996 and is the last original member of the Fresno crew.', [
    ['Mei', 'PERSON'],
    ['hired in 1996', 'TENURE'],
    ['the last original member of the Fresno crew', 'ROLE'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] was [TENURE_1] and is [ROLE_1].')
  assert.deepEqual(r.counts, { EMPLOYEE: 1, TENURE: 1, ROLE: 1 })
})

// --- Family medical details ------------------------------------------------------------------

test("10. a relative's medical detail becomes [FAMILY_MEDICAL_1]", () => {
  const r = run("Grace asked to leave early on Tuesdays for her mother's dialysis.", [
    ['Grace', 'PERSON'],
    ["her mother's dialysis", 'FAMILY_MEDICAL'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] asked to leave early on Tuesdays for [FAMILY_MEDICAL_1].')
  assert.equal(restore(r.text, r.map), "Grace asked to leave early on Tuesdays for her mother's dialysis.")
})

test("11. a relative's condition and the employee's own stay separate", () => {
  const r = run("Arjun said his son's autism diagnosis means frequent school calls. Arjun also has migraines.", [
    ['Arjun', 'PERSON'],
    ["his son's autism diagnosis", 'FAMILY_MEDICAL'],
    ['migraines', 'MEDICAL'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] said [FAMILY_MEDICAL_1] means frequent school calls. [EMPLOYEE_1] also has [MEDICAL_1].')
  assert.deepEqual(r.leaks, [])
})

test('12. manager emails and termination letters never get family medical details back', () => {
  const r = run("Grace needs Tuesday afternoons off for her mother's dialysis.", [
    ['Grace', 'PERSON'],
    ["her mother's dialysis", 'FAMILY_MEDICAL'],
  ])
  const draft = 'Please approve the schedule change for [EMPLOYEE_1] ([ family_medical 1 ]).'
  const checked = checkDraft(draft, r.map, 'accommodation')
  assert.match(checked.warnings.join(' '), /Withheld 1 FAMILY_MEDICAL/)
  assert.equal(restore(checked.text, r.map, TEMPLATES.accommodation.withhold), 'Please approve the schedule change for Grace ([withheld]).')
  for (const t of Object.values(TEMPLATES)) {
    if (t.withhold.includes('MEDICAL')) assert.ok(t.withhold.includes('FAMILY_MEDICAL'), `${t.id} must withhold FAMILY_MEDICAL`)
  }
})

// --- Things that must NOT be hidden or split, and the safety net ------------------------------

test('13. a meeting labeled as a department stays visible; the role is still hidden', () => {
  const r = run('After the Oct 3 team meeting, the only contractor on the HVAC crew was sent home.', [
    ['the only contractor on the HVAC crew', 'ROLE'],
    ['the Oct 3 team meeting', 'DEPARTMENT'],
  ])
  assert.equal(r.text, 'After the Oct 3 team meeting, [ROLE_1] on the [DEPT_1] was sent home.')
})

test('14. "in charge of" is not a team, so the phrase stays whole and no stray DEPT is kept', () => {
  const r = run('Ana is the only nurse in charge of the ICU night shift.', [
    ['Ana', 'PERSON'],
    ['the only nurse in charge of the ICU night shift', 'ROLE'],
    ['the ICU night shift', 'DEPARTMENT'],
  ])
  assert.equal(r.text, '[EMPLOYEE_1] is [ROLE_1].')
  assert.deepEqual(r.counts, { EMPLOYEE: 1, ROLE: 1 })
  assert.equal(restore(r.text, r.map), 'Ana is the only nurse in charge of the ICU night shift.')
})

test('15. if Nano misses an indirect identifier, the leak re-check catches it (send is blocked)', () => {
  const r = run('Joy is the only Filipino nurse in the ICU.', [['Joy', 'PERSON']])
  assert.equal(r.text, '[EMPLOYEE_1] is the only Filipino nurse in the ICU.')
  assert.deepEqual(r.leaks, [{ category: 'INDIRECT', text: 'the only Filipino nurse in the ICU' }])
})

// --- Prompt and schema -----------------------------------------------------------------------

test('schema and prompt cover every category, including the indirect ones', () => {
  const allowed = ENTITY_SCHEMA.properties.entities.items.properties.category.enum
  for (const c of ['ROLE', 'DEPARTMENT', 'TENURE', 'FAMILY_MEDICAL']) assert.ok(allowed.includes(c), c)
  for (const c of allowed) assert.ok(INSTRUCTIONS.includes(c), `prompt never explains ${c}`)
  assert.match(INSTRUCTIONS, /two entities, not one/)
  assert.match(buildPrompt('x', ['the only woman']), /missed these.*"the only woman"/)
})

test('reply parsing accepts lower-case categories and drops unknown ones', () => {
  const raw = 'Sure: {"entities":[{"text":"Treasury","category":"department"},{"text":"x","category":"VIBE"}]}'
  assert.deepEqual(parseEntities(raw), [{ text: 'Treasury', category: 'DEPARTMENT' }])
})
