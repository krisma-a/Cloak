// Run with: npm test   (fake data only)
// Local receipts: written before each cloud call, finished after it. Uses an in-memory store
// (Node has no IndexedDB); the IndexedDB store is checked in the browser.
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRawPolicy, DEFAULT_POLICY, getPolicy, resetPolicy } from '../policy.ts'
import { sha256Hex } from './receipt.ts'
import { SendBlockedError } from './errors.ts'
import {
  currentConfig,
  newestFirst,
  policyFingerprint,
  recordedCall,
  type LocalReceipt,
  type ReceiptStore,
} from './receiptLog.ts'
import { applyEntities } from './placeholders.ts'
import { buildDraftPrompt } from './templates.ts'

afterEach(() => resetPolicy())

/** Stands in for IndexedDB. Copies on the way in and out, like a real store. */
class MemoryStore implements ReceiptStore {
  rows = new Map<string, LocalReceipt>()
  /** Makes a write fail when this returns true (to test each failure path). */
  failIf: (receipt: LocalReceipt) => boolean = () => false
  async put(receipt: LocalReceipt): Promise<void> {
    if (this.failIf(receipt)) throw new Error('simulated write failure')
    this.rows.set(receipt.id, structuredClone(receipt))
  }
  async list(): Promise<LocalReceipt[]> {
    return [...this.rows.values()].map((r) => structuredClone(r))
  }
}

const fixed = (iso: string) => () => new Date(iso)
const ok = (source: string) => async () => ({ text: 'the draft', source })

test('the fingerprint is stable for the same settings and changes when one changes', async () => {
  const a = await policyFingerprint(DEFAULT_POLICY)
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(await policyFingerprint({ ...DEFAULT_POLICY }), a)
  assert.notEqual(await policyFingerprint({ ...DEFAULT_POLICY, max_retries: 3 }), a)
  assert.notEqual(await policyFingerprint({ ...DEFAULT_POLICY, cloud_model: 'gemini-3.6-pro' }), a)
  assert.notEqual(await policyFingerprint({ ...DEFAULT_POLICY, redact_salary: false }), a)
})

test('the receipt is written before the call, so the call can already see it', async () => {
  const store = new MemoryStore()
  let seen: LocalReceipt[] = []
  const result = await recordedCall(
    store,
    { name: 'draft', model: 'gemini-3.6-flash', sentText: 'Hello [EMPLOYEE_1]' },
    async () => {
      seen = await store.list()
      return { text: 'ok', source: 'in_cloud' }
    },
  )
  assert.equal(result.text, 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].status, 'pending')
  assert.equal(seen[0].steps[0].inferenceSource, null)
})

test('a finished receipt holds the exact text, its hash, the model, the settings, and where the call ran', async () => {
  applyRawPolicy({ max_retries: '3' }, { source: 'remote', fetchedAt: Date.parse('2026-11-23T09:00:00Z') })
  const store = new MemoryStore()
  const prompt = 'Summarize [EMPLOYEE_1] and [ROLE_1] for the file.'
  await recordedCall(
    store,
    { name: 'draft', model: 'gemini-3.6-flash', sentText: prompt },
    ok('in_cloud'),
    fixed('2026-11-23T10:00:00Z'),
  )
  const [r] = await store.list()
  assert.equal(r.status, 'done')
  assert.equal(r.sentText, prompt)
  assert.equal(r.sha256, await sha256Hex(prompt))
  assert.equal(r.model, 'gemini-3.6-flash')
  assert.equal(r.config.fingerprint, await policyFingerprint(getPolicy()))
  assert.equal(r.config.source, 'remote')
  assert.equal(r.config.fetchedAt, '2026-11-23T09:00:00.000Z')
  assert.equal(r.createdAt, '2026-11-23T10:00:00.000Z')
  assert.deepEqual(r.steps, [
    { name: 'draft', startedAt: '2026-11-23T10:00:00.000Z', finishedAt: '2026-11-23T10:00:00.000Z', inferenceSource: 'in_cloud' },
  ])
  assert.equal(r.error, null)
})

test('a call that ran on the device is recorded as on_device (tagging and tone may fall back to the cloud)', async () => {
  const store = new MemoryStore()
  await recordedCall(store, { name: 'tag-case-type', model: 'gemini-3.6-flash', sentText: 'Classify' }, ok('on_device'))
  const [r] = await store.list()
  assert.equal(r.steps[0].inferenceSource, 'on_device')
})

test('a missing inferenceSource is recorded as unknown', async () => {
  const store = new MemoryStore()
  await recordedCall(store, { name: 'draft', model: 'gemini-3.6-flash', sentText: 'x' }, ok(''))
  const [r] = await store.list()
  assert.equal(r.steps[0].inferenceSource, 'unknown')
})

test('if the receipt cannot be saved first, the call is never made and the send is refused', async () => {
  const store = new MemoryStore()
  store.failIf = (r) => r.status === 'pending'
  let called = false
  await assert.rejects(
    recordedCall(store, { name: 'draft', model: 'gemini-3.6-flash', sentText: 'x' }, async () => {
      called = true
      return { text: '', source: 'in_cloud' }
    }),
    (e: unknown) => e instanceof SendBlockedError && /nothing was sent/.test((e as Error).message),
  )
  assert.equal(called, false)
  assert.equal((await store.list()).length, 0)
})

test('a failed call is recorded as failed, and its error is passed on unchanged', async () => {
  const store = new MemoryStore()
  const err = new Error('Quota exceeded for this project')
  await assert.rejects(
    recordedCall(store, { name: 'draft', model: 'gemini-3.6-flash', sentText: 'x' }, async () => {
      throw err
    }),
    err,
  )
  const [r] = await store.list()
  assert.equal(r.status, 'failed')
  assert.match(r.error ?? '', /^Error: Quota exceeded/)
  assert.ok(r.steps[0].finishedAt, 'the failed step has an end time')
  assert.equal(r.steps[0].inferenceSource, null)
})

test('if the final write fails, the result is still returned and the receipt stays pending', async () => {
  const store = new MemoryStore()
  store.failIf = (r) => r.status === 'done'
  const result = await recordedCall(store, { name: 'draft', model: 'gemini-3.6-flash', sentText: 'x' }, ok('in_cloud'))
  assert.equal(result.text, 'the draft')
  const [r] = await store.list()
  assert.equal(r.status, 'pending')
})

test('the receipt holds the redacted prompt, never the names or the hidden details', async () => {
  const { text } = applyEntities('Maria Santos has type 2 diabetes. Her salary is $68,500.', [
    { text: 'Maria Santos', category: 'PERSON' },
    { text: 'type 2 diabetes', category: 'MEDICAL' },
    { text: '$68,500', category: 'SALARY' },
  ])
  const prompt = buildDraftPrompt(text, 'investigation')
  const store = new MemoryStore()
  await recordedCall(store, { name: 'draft', model: 'gemini-3.6-flash', sentText: prompt }, ok('in_cloud'))
  const json = JSON.stringify(await store.list())
  for (const secret of ['Maria', 'Santos', 'diabetes', '68,500']) assert.ok(!json.includes(secret), secret)
  assert.match(json, /\[EMPLOYEE_1\]/)
  assert.match(json, /\[MEDICAL_DETAIL_1\]/)
})

test('each receipt gets its own id, and the list is newest first', async () => {
  const store = new MemoryStore()
  await recordedCall(store, { name: 'draft', model: 'm', sentText: 'first' }, ok('in_cloud'), fixed('2026-11-23T10:00:00Z'))
  await recordedCall(store, { name: 'draft', model: 'm', sentText: 'second' }, ok('in_cloud'), fixed('2026-11-23T11:00:00Z'))
  const rows = newestFirst(await store.list())
  assert.deepEqual(rows.map((r) => r.sentText), ['second', 'first'])
  assert.notEqual(rows[0].id, rows[1].id)
})

test('the config in a receipt follows the live settings', async () => {
  const before = await currentConfig()
  assert.equal(before.source, 'defaults')
  applyRawPolicy({ medical_mode: 'block' }, { source: 'remote' })
  const after = await currentConfig()
  assert.equal(after.source, 'remote')
  assert.notEqual(after.fingerprint, before.fingerprint)
  assert.equal(after.fingerprint, await policyFingerprint(getPolicy()))
})
