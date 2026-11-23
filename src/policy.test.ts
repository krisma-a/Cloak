// Run with: npm test   (fake data only)
// The four Remote Config settings: how raw values are read, and what each one changes.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasMedicalDetail, redactionBlockReason, sendBlockReason } from './ai/guard.ts'
import { applyEntities, countByPrefix, type Category } from './ai/placeholders.ts'
import type { RedactionResult } from './ai/redact.ts'
import { restrictionProblem } from './ai/restrictionPrompt.ts'
import {
  applyRawPolicy,
  DEFAULT_POLICY,
  expectPolicyLoad,
  getPolicy,
  getPolicySnapshot,
  parsePolicy,
  resetPolicy,
  setPolicyDefaults,
  subscribePolicy,
  whenPolicyReady,
} from './policy.ts'
import { findLeaks } from './rules/rules.ts'

afterEach(() => resetPolicy())

const use = (raw: Parameters<typeof applyRawPolicy>[0]) => applyRawPolicy(raw, { source: 'remote' })

function redactionOf(note: string, found: Array<[string, Category]>): RedactionResult {
  const { text, map } = applyEntities(note, found.map(([text, category]) => ({ text, category })))
  return {
    status: 'ok', engine: 'nano', needsCarefulReview: false, names: 'model', redactedText: text, map,
    leaks: [], attempts: 1, ranOn: 'on_device', counts: countByPrefix(map),
  }
}

// --- Reading the raw values --------------------------------------------------------------------

test('nothing set means the built-in defaults', () => {
  assert.deepEqual(parsePolicy({}), { policy: DEFAULT_POLICY, warnings: [] })
  assert.deepEqual(parsePolicy({ redact_salary: '', medical_mode: '  ', max_retries: '', cloud_model: '' }).warnings, [])
})

test('good values are read', () => {
  const { policy, warnings } = parsePolicy({
    redact_salary: ' FALSE ', medical_mode: 'Block', max_retries: '4', cloud_model: 'gemini-3.6-pro',
  })
  assert.deepEqual(policy, { redact_salary: false, medical_mode: 'block', max_retries: 4, cloud_model: 'gemini-3.6-pro' })
  assert.deepEqual(warnings, [])
  for (const yes of ['true', '1', 'yes', 'on']) assert.equal(parsePolicy({ redact_salary: yes }).policy.redact_salary, true)
  for (const no of ['false', '0', 'no', 'off']) assert.equal(parsePolicy({ redact_salary: no }).policy.redact_salary, false)
})

test('a value that cannot be read fails toward MORE privacy', () => {
  const salary = parsePolicy({ redact_salary: 'flase' })
  assert.equal(salary.policy.redact_salary, true)
  assert.match(salary.warnings[0], /salary stays hidden/)
  const medical = parsePolicy({ medical_mode: 'blok' })
  assert.equal(medical.policy.medical_mode, 'block')
  assert.match(medical.warnings[0], /blocked/)
})

test('max_retries must be a whole number from 0 to 5', () => {
  assert.equal(parsePolicy({ max_retries: '0' }).policy.max_retries, 0)
  assert.equal(parsePolicy({ max_retries: '-3' }).policy.max_retries, 0)
  assert.equal(parsePolicy({ max_retries: '99' }).policy.max_retries, 5)
  for (const bad of ['2.5', 'abc', 'Infinity']) {
    const r = parsePolicy({ max_retries: bad })
    assert.equal(r.policy.max_retries, DEFAULT_POLICY.max_retries, bad)
    assert.equal(r.warnings.length, 1, bad)
  }
})

test('cloud_model must look like a model name', () => {
  assert.equal(parsePolicy({ cloud_model: 'gemini-3.6-flash-lite' }).policy.cloud_model, 'gemini-3.6-flash-lite')
  for (const bad of ['bad model!', 'x', 'https://evil.example/model', '../x']) {
    const r = parsePolicy({ cloud_model: bad })
    assert.equal(r.policy.cloud_model, DEFAULT_POLICY.cloud_model, bad)
    assert.equal(r.warnings.length, 1, bad)
  }
})

// --- The live store ----------------------------------------------------------------------------

test('applying values updates getPolicy and tells subscribers', () => {
  let calls = 0
  const stop = subscribePolicy(() => calls++)
  const before = getPolicySnapshot()
  assert.equal(getPolicySnapshot(), before, 'same object until something changes')
  use({ medical_mode: 'block', max_retries: '3' })
  assert.equal(getPolicy().medical_mode, 'block')
  assert.equal(getPolicy().max_retries, 3)
  assert.equal(getPolicySnapshot().status.source, 'remote')
  assert.ok(calls >= 1)
  stop()
  use({ medical_mode: 'generalize' })
  assert.equal(calls, 1, 'no calls after unsubscribing')
})

test('a value Remote Config drops goes back to the default', () => {
  use({ redact_salary: 'false' })
  assert.equal(getPolicy().redact_salary, false)
  use({}) // the console parameter was deleted
  assert.equal(getPolicy().redact_salary, true)
})

test('the built-in default can be changed (VITE_CLOUD_MODEL) until Remote Config answers', () => {
  setPolicyDefaults({ cloud_model: 'gemini-3.6-pro' })
  assert.equal(getPolicy().cloud_model, 'gemini-3.6-pro')
  use({ max_retries: '1' }) // Remote Config answered but has no cloud_model
  assert.equal(getPolicy().cloud_model, 'gemini-3.6-pro')
  use({ cloud_model: 'gemini-3.6-flash' })
  assert.equal(getPolicy().cloud_model, 'gemini-3.6-flash')
})

test('redact() and draft() can wait for the first fetch, even if it fails', async () => {
  await whenPolicyReady() // nothing registered: resolves at once
  let finish!: () => void
  expectPolicyLoad(new Promise<void>((resolve) => (finish = resolve)))
  let done = false
  const waiting = whenPolicyReady().then(() => (done = true))
  await Promise.resolve()
  assert.equal(done, false)
  finish()
  await waiting
  assert.equal(done, true)
  expectPolicyLoad(Promise.reject(new Error('offline')))
  await whenPolicyReady() // a failed fetch does not throw
})

// --- redact_salary -----------------------------------------------------------------------------

test('redact_salary=false lets pay stay visible, and only pay', () => {
  const text = 'Pay is $68,500. Reach her at maria@example.com. SSN 123-45-6789.'
  assert.deepEqual(findLeaks(text).map((l) => l.category).sort(), ['EMAIL', 'SALARY', 'SSN'])
  use({ redact_salary: 'false' })
  assert.deepEqual(findLeaks(text).map((l) => l.category).sort(), ['EMAIL', 'SSN'])
  assert.deepEqual(findLeaks(text, [], { ignorePolicy: true }).map((l) => l.category).sort(), ['EMAIL', 'SALARY', 'SSN'])
})

test('with redact_salary=false a note with visible pay can be sent; with true it cannot', () => {
  const r = redactionOf('Maria earns $68,500 a year.', [['Maria', 'PERSON']])
  assert.match(redactionBlockReason(r) ?? '', /leak re-check/)
  use({ redact_salary: 'false' })
  assert.equal(sendBlockReason(r, true), null)
  use({ redact_salary: 'true' })
  assert.match(sendBlockReason(r, true) ?? '', /leak re-check/)
})

test('a work restriction can never contain money, whatever redact_salary says', () => {
  use({ redact_salary: 'false' })
  const { map, text } = redactionOf('Maria needs a break.', [['Maria', 'PERSON']])
  assert.match(restrictionProblem('keep pay at $68,500 during breaks', map, text) ?? '', /private detail/)
})

// --- medical_mode ------------------------------------------------------------------------------

test('medical_mode=generalize sends notes with medical details (the default)', () => {
  const r = redactionOf('Maria has type 2 diabetes.', [['Maria', 'PERSON'], ['type 2 diabetes', 'MEDICAL']])
  assert.equal(hasMedicalDetail(r), true)
  assert.equal(redactionBlockReason(r), null)
})

test('medical_mode=block refuses any note that has a medical detail', () => {
  use({ medical_mode: 'block' })
  const own = redactionOf('Maria has type 2 diabetes.', [['Maria', 'PERSON'], ['type 2 diabetes', 'MEDICAL']])
  const family = redactionOf("Maria needs Tuesdays for her mother's dialysis.", [['Maria', 'PERSON'], ["her mother's dialysis", 'FAMILY_MEDICAL']])
  for (const r of [own, family]) {
    assert.match(sendBlockReason(r, true) ?? '', /medical mode is "block"/)
    assert.match(redactionBlockReason(r) ?? '', /medical mode is "block"/, 'tagging and tone rewrite are blocked too')
  }
})

test('medical_mode=block also catches a medical word the user chose to leave visible', () => {
  use({ medical_mode: 'block' })
  const visible = redactionOf('Maria has diabetes.', [['Maria', 'PERSON']])
  assert.equal(hasMedicalDetail(visible), true)
  assert.match(redactionBlockReason(visible) ?? '', /medical mode is "block"/)
})

test('medical_mode=block lets a note without medical details through', () => {
  use({ medical_mode: 'block' })
  const r = redactionOf('Maria was late on Oct 3.', [['Maria', 'PERSON']])
  assert.equal(hasMedicalDetail(r), false)
  assert.equal(sendBlockReason(r, true), null)
})

test('a misspelled medical_mode blocks instead of silently allowing', () => {
  use({ medical_mode: 'generlize' })
  const r = redactionOf('Maria has type 2 diabetes.', [['Maria', 'PERSON'], ['type 2 diabetes', 'MEDICAL']])
  assert.match(sendBlockReason(r, true) ?? '', /medical mode is "block"/)
})
