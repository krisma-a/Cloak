import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addDraftRecord, clearHistory, estimateDraftCost, formatTokens, formatUsd, loadHistory, MAX_RECORDS, monthlyCost, receiptLines,
  summarizeHistory,
} from './draftCost.ts'
import type { DraftCost, DraftRecord } from './draftCost.ts'

const cost = (over: Partial<DraftCost> = {}): DraftCost => ({
  model: 'gemini-3.6-flash', inputTokens: 1820, outputTokens: 640, thinkingTokens: 310, estimated: false, costUsd: 0.009855, priceVersion: '2026-11-24', ...over,
})
const record = (over: Partial<DraftRecord> = {}): DraftRecord => ({ ...cost(), at: 1, demo: false, ...over })
const memory = () => {
  const store = new Map<string, string>()
  return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
}

test('money is written plainly, with more places for small amounts', () => {
  assert.equal(formatUsd(0.009855), "$0.0099")
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(0.00001), '<$0.0001')
  assert.equal(formatUsd(12.3456), '$12.35')
  assert.equal(formatUsd(null), '—')
  assert.equal(formatTokens(1820), '1,820')
})

test('the receipt lines add up to the total (paid-tier price: $1.50 in, $7.50 out, thinking billed as out)', () => {
  const lines = receiptLines(cost())
  assert.deepEqual(lines.map((l) => l.label), ['Text sent to the cloud', 'Draft written', 'Thinking'])
  const sum = lines.reduce((s, l) => s + (l.amount as number), 0)
  assert.ok(Math.abs(sum - 0.009855) < 0.000001, String(sum))
  assert.equal(receiptLines(cost({ thinkingTokens: 0 })).length, 2)
  assert.ok(receiptLines(cost({ model: 'unlisted-model' })).every((l) => l.amount === null))
})

test('the estimate grows with the text, stays inside sensible limits and is labelled an estimate', () => {
  const small = estimateDraftCost(2000)
  const big = estimateDraftCost(60_000)
  assert.equal(small.estimated, true)
  assert.equal(small.inputTokens, 500)
  assert.equal(small.outputTokens, 450)
  assert.equal(big.outputTokens, 1400)
  assert.ok((big.costUsd as number) > (small.costUsd as number))
  assert.equal(estimateDraftCost(0).outputTokens, 350)
})

test('the monthly planner multiplies drafts a day by working days', () => {
  assert.ok(Math.abs(monthlyCost(0.01, 10) - 2.2) < 1e-9)
  assert.equal(monthlyCost(0.01, 0), 0)
  assert.equal(monthlyCost(-1, 5), 0)
})

test('history keeps numbers only, newest 200, drops junk, and clears', () => {
  const storage = memory()
  assert.deepEqual(loadHistory(storage), [])
  addDraftRecord({ ...record(), text: 'Maria Santos has diabetes' } as DraftRecord, storage)
  const saved = storage.getItem('cloak.draftCosts') ?? ''
  assert.ok(!/Maria|diabetes/.test(saved), 'no text can get in')
  assert.equal(loadHistory(storage).length, 1)
  storage.setItem('cloak.draftCosts', JSON.stringify([{ nonsense: true }, record()]))
  assert.equal(loadHistory(storage).length, 1)
  for (let i = 0; i < MAX_RECORDS + 20; i++) addDraftRecord(record({ at: i }), storage)
  const all = loadHistory(storage)
  assert.equal(all.length, MAX_RECORDS)
  assert.equal(all.at(-1)?.at, MAX_RECORDS + 19)
  clearHistory(storage)
  assert.deepEqual(loadHistory(storage), [])
  const blocked = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') }, removeItem: () => { throw new Error('no') } }
  assert.deepEqual(loadHistory(blocked), [])
  assert.doesNotThrow(() => addDraftRecord(record(), blocked))
})

test('the summary counts demo drafts but never adds them to the spend', () => {
  const s = summarizeHistory([record({ costUsd: 0.01 }), record({ costUsd: 0.03 }), record({ demo: true, costUsd: 0.5 }), record({ costUsd: null })])
  assert.equal(s.drafts, 3)
  assert.equal(s.demoDrafts, 1)
  assert.ok(Math.abs(s.total - 0.04) < 1e-9)
  assert.ok(Math.abs((s.average as number) - 0.02) < 1e-9)
  assert.deepEqual(s.recent, [0.01, 0.03])
  assert.equal(summarizeHistory([]).average, null)
})
