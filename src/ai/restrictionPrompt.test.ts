// Run with: npm test   (fake data only)
// Medical details -> functional work restrictions. A Nano-shaped JSON reply goes through the same
// code the app runs (parse -> checks -> manager prompt -> draft check -> restore). These test our
// side; whether Nano writes good restrictions can only be measured in Chrome with the real model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEntities, HEALTH_PREFIXES, restore, sensitiveStrings, type Category } from './placeholders.ts'
import {
  accommodationBlockReason,
  buildRestrictionPrompt,
  cleanRestrictions,
  healthContext,
  healthWording,
  parseRestrictions,
  RESTRICTION_KINDS,
  RESTRICTION_SCHEMA,
  restrictionProblem,
} from './restrictionPrompt.ts'
import { buildManagerPrompt, checkDraft, TEMPLATES } from './templates.ts'

const NOTE =
  "Maria Santos (EMP-40912) reported that her supervisor Chidi Okafor mocked her accent. " +
  "She has type 2 diabetes and needs a short break every 2 hours. " +
  "Her mother's dialysis means she must leave at 3 pm on Tuesdays. Salary: $68,500."

function redactNote(note: string, found: Array<[string, Category]>) {
  return applyEntities(note, found.map(([text, category]) => ({ text, category })))
}

const main = redactNote(NOTE, [
  ['Maria Santos', 'PERSON'],
  ['Chidi Okafor', 'PERSON'],
  ['EMP-40912', 'EMPLOYEE_ID'],
  ['type 2 diabetes', 'MEDICAL'],
  ["Her mother's dialysis", 'FAMILY_MEDICAL'],
  ['$68,500', 'SALARY'],
])

/** What Nano would send back, run through the same parse and checks as the app. */
function rewrite(note: ReturnType<typeof redactNote>, reply: Array<[string, string]>) {
  const raw = JSON.stringify({ restrictions: reply.map(([kind, text]) => ({ kind, text })) })
  return cleanRestrictions(parseRestrictions(raw), note.map, note.text)
}

// --- Where the original goes -------------------------------------------------------------------

test('the original diagnosis stays on this device as [MEDICAL_DETAIL_n]', () => {
  assert.equal(main.map.originals['[MEDICAL_DETAIL_1]'], 'type 2 diabetes')
  assert.equal(main.map.originals['[FAMILY_MEDICAL_1]'], "her mother's dialysis")
  assert.match(main.text, /\[MEDICAL_DETAIL_1\]/)
  assert.ok(!/diabetes|dialysis/i.test(main.text), 'the redacted text must not contain a diagnosis')
})

test('Nano is shown the health details, but names, ids and pay stay hidden', () => {
  const context = healthContext(main.text, main.map)
  assert.match(context, /type 2 diabetes/)
  assert.match(context, /mother's dialysis/)
  assert.ok(!/Maria|Chidi|40912|68,500/.test(context))
  assert.match(context, /\[EMPLOYEE_1\]/)
  assert.match(buildRestrictionPrompt(context), /never WHY/)
})

test('schema and prompt cover every restriction kind', () => {
  const allowed = RESTRICTION_SCHEMA.properties.restrictions.items.properties.kind.enum
  assert.deepEqual(allowed, [...RESTRICTION_KINDS])
  for (const kind of allowed) assert.match(buildRestrictionPrompt(''), new RegExp(kind))
})

test('reply parsing tolerates stray text, lower-case kinds and unknown kinds', () => {
  const raw = 'Here: {"restrictions":[{"kind":"breaks","text":" a break "},{"kind":"VIBES","text":"x y z"},{"kind":"DUTIES","text":" "}]}'
  assert.deepEqual(parseRestrictions(raw), [
    { kind: 'BREAKS', text: 'a break' },
    { kind: 'OTHER', text: 'x y z' },
  ])
  assert.deepEqual(parseRestrictions('not json'), [])
})

// --- Rewrites: what survives the checks ----------------------------------------------------------

test('good functional restrictions are kept', () => {
  const r = rewrite(main, [
    ['BREAKS', 'a short break every 2 hours'],
    ['SCHEDULE', 'leave at 3 pm on Tuesdays'],
    ['LIFTING', 'no lifting over 20 lbs'],
  ])
  assert.deepEqual(r.kept.map((k) => k.text), ['a short break every 2 hours', 'leave at 3 pm on Tuesdays', 'no lifting over 20 lbs'])
  assert.equal(r.dropped, 0)
})

test('a restriction that names the diagnosis is rejected', () => {
  const r = rewrite(main, [['BREAKS', 'breaks to manage diabetes'], ['BREAKS', 'a short break every 2 hours']])
  assert.deepEqual(r.kept.map((k) => k.text), ['a short break every 2 hours'])
  assert.equal(r.dropped, 1)
})

test('health wording the word list knows is rejected even when it is not in the notes', () => {
  for (const bad of ['time to check blood sugar', 'accommodations for her condition', 'leave for a doctor visit', 'rest because of pain']) {
    assert.match(restrictionProblem(bad, main.map, main.text) ?? '', /health wording|hidden health/, bad)
  }
  assert.equal(restrictionProblem('cooler working conditions', main.map, main.text), null)
})

test("a relative's condition or relationship is rejected too", () => {
  assert.match(restrictionProblem('leave early for her mother', main.map, main.text) ?? '', /hidden health detail/)
  assert.match(restrictionProblem('leave early for dialysis days', main.map, main.text) ?? '', /dialysis/)
})

test('a health word nobody put on a word list is still caught, because it was in the notes', () => {
  const n = redactNote('Ana has ulcerative colitis and needs easy access to a restroom.', [
    ['Ana', 'PERSON'],
    ['ulcerative colitis', 'MEDICAL'],
  ])
  assert.equal(healthWording('restroom access because of colitis'), null) // not on any list
  const r = rewrite(n, [['OTHER', 'restroom access because of colitis'], ['WORKSTATION', 'easy access to a restroom']])
  assert.deepEqual(r.kept.map((k) => k.text), ['easy access to a restroom'])
  assert.equal(r.dropped, 1)
})

test('names, placeholders, contact details and pay are rejected', () => {
  for (const bad of ['Maria needs breaks', '[MEDICAL_DETAIL_1] related breaks', 'call 555-201-7788 about breaks', 'pay stays $68,500 during breaks']) {
    assert.notEqual(restrictionProblem(bad, main.map, main.text), null, bad)
  }
})

test('duplicates collapse, long lines are rejected, at most 8 are kept', () => {
  const dup = rewrite(main, [['BREAKS', 'A short break every 2 hours'], ['BREAKS', 'a short break every 2 hours']])
  assert.equal(dup.kept.length, 1)
  assert.equal(dup.dropped, 0)
  assert.match(restrictionProblem('a short break '.repeat(20), main.map, main.text) ?? '', /too long/)
  const many = rewrite(main, Array.from({ length: 12 }, (_, i) => ['OTHER', `no lifting over ${20 + i} lbs`] as [string, string]))
  assert.equal(many.kept.length, 8)
  assert.equal(many.dropped, 4)
})

// --- Manager email: restrictions only ------------------------------------------------------------

test('approval needs at least one restriction and a known employee', () => {
  const ok = { employee: '[EMPLOYEE_1]', restrictions: ['a short break every 2 hours', ''] }
  assert.equal(accommodationBlockReason(ok, main.map, main.text), null)
  assert.match(accommodationBlockReason(undefined, main.map, main.text) ?? '', /add at least one work restriction/)
  assert.match(accommodationBlockReason({ ...ok, restrictions: [' '] }, main.map, main.text) ?? '', /add at least one/)
  for (const employee of ['', '[EMPLOYEE_9]', '[MEDICAL_DETAIL_1]']) {
    assert.match(accommodationBlockReason({ ...ok, employee }, main.map, main.text) ?? '', /choose which employee/, employee)
  }
})

test('edited restrictions are checked again at send time', () => {
  const plan = { employee: '[EMPLOYEE_1]', restrictions: ['a short break every 2 hours', 'extra breaks for diabetes'] }
  assert.match(accommodationBlockReason(plan, main.map, main.text) ?? '', /^Not sent: restriction 2 /)
})

test('the manager prompt holds the employee placeholder and the restrictions, nothing else', () => {
  const prompt = buildManagerPrompt('[EMPLOYEE_1]', ['a short break every 2 hours', 'leave at 3 pm on Tuesdays', ''])
  assert.match(prompt, /Employee: \[EMPLOYEE_1\]/)
  assert.match(prompt, /1\. a short break every 2 hours\n2\. leave at 3 pm on Tuesdays$/)
  for (const secret of sensitiveStrings(main.map)) assert.ok(!prompt.toLowerCase().includes(secret), `prompt leaks "${secret}"`)
  assert.ok(!/\[(?:MEDICAL_DETAIL|FAMILY_MEDICAL|SALARY|ID)_\d+\]/.test(prompt), 'no health, pay or id placeholder either')
  assert.ok(!/mocked|accent|supervisor/.test(prompt), 'none of the case notes')
})

test('a manager draft is checked for health wording and never gets a diagnosis back', () => {
  const clean = checkDraft('Hi, please let [EMPLOYEE_1] take a short break every 2 hours.', main.map, 'accommodation')
  assert.deepEqual(clean.warnings, [])
  const wordy = checkDraft('Please allow [EMPLOYEE_1] breaks for their medical condition.', main.map, 'accommodation')
  assert.match(wordy.warnings.join(' '), /health wording/)

  const cloud = 'Hi, [EMPLOYEE_1] needs a short break every 2 hours. [Medical Detail 1] / [FAMILY_MEDICAL_1]'
  const checked = checkDraft(cloud, main.map, 'accommodation')
  const final = restore(checked.text, main.map, TEMPLATES.accommodation.withhold)
  assert.equal(final, 'Hi, Maria Santos needs a short break every 2 hours. [withheld] / [withheld]')
  assert.ok(!/diabetes|dialysis/i.test(final))
})

test('only the manager email is restrictions-only, and every template withholds health details', () => {
  assert.deepEqual(Object.values(TEMPLATES).filter((t) => t.input === 'restrictions').map((t) => t.id), ['accommodation'])
  for (const t of Object.values(TEMPLATES)) {
    for (const prefix of HEALTH_PREFIXES) assert.ok(t.withhold.includes(prefix), `${t.id} must withhold ${prefix}`)
  }
})
