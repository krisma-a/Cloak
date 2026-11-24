import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  buildUsageEvent,
  costUsd,
  groupUsage,
  ON_DEVICE_MODEL,
  PRICE_VERSION,
  PRICE_VERSION_PATTERN,
  totalUsage,
  USAGE_FIELDS,
  USAGE_LABELS,
  USAGE_MODEL_PATTERN,
  USAGE_ORIGINS,
  USAGE_PLACES,
  usageTimeline,
  validateUsageEvent,
  type UsageInput,
  type UsageRow,
} from './usage.ts'

const cloudDraft: UsageInput = {
  label: 'draft',
  model: 'models/gemini-3.6-flash',
  source: 'in_cloud',
  usage: { promptTokenCount: 342, candidatesTokenCount: 420, thoughtsTokenCount: 2429 },
  promptChars: 1334,
  outputChars: 1513,
}

test('a cloud call is priced at input + (output + thinking) on the paid tier', () => {
  const event = buildUsageEvent(cloudDraft)
  assert.ok(event)
  assert.equal(event.model, 'gemini-3.6-flash')
  assert.equal(event.ranOn, 'in_cloud')
  assert.deepEqual([event.inputTokens, event.outputTokens, event.thinkingTokens], [342, 420, 2429])
  assert.equal(event.estimated, false)
  // 342 × $1.50/M + (420 + 2429) × $7.50/M
  assert.ok(Math.abs((event.costUsd ?? 0) - (342 * 1.5 + 2849 * 7.5) / 1e6) < 1e-12)
  assert.equal(event.priceVersion, PRICE_VERSION)
  assert.equal(validateUsageEvent(event), null)
})

test('an on-device call costs nothing and its tokens are estimated when the SDK reports none', () => {
  const event = buildUsageEvent({ label: 'redact', model: 'models/whatever', source: 'on_device', promptChars: 801, outputChars: 40 })
  assert.ok(event)
  assert.equal(event.model, ON_DEVICE_MODEL)
  assert.equal(event.costUsd, 0)
  assert.equal(event.estimated, true)
  assert.deepEqual([event.inputTokens, event.outputTokens, event.thinkingTokens], [201, 10, 0])
  assert.equal(validateUsageEvent(event), null)
})

test('a model with no listed price gets a null cost, not a guess', () => {
  assert.equal(costUsd('gemini-9-ultra', 'in_cloud', { input: 10, output: 10, thinking: 0 }), null)
  const event = buildUsageEvent({ ...cloudDraft, model: 'models/gemini-9-ultra' })
  assert.equal(event?.costUsd, null)
  assert.equal(validateUsageEvent(event), null)
})

test('nothing outside the fixed lists gets into a record', () => {
  assert.equal(buildUsageEvent({ ...cloudDraft, label: 'Pat Rivers said' }), null)
  const odd = buildUsageEvent({ ...cloudDraft, model: 'Pat Rivers was late on Mar 3', source: 'somewhere', origin: 'x' as never })
  assert.ok(odd)
  assert.equal(odd.model, 'unknown')
  assert.equal(odd.ranOn, 'in_cloud') // unknown source counts as cloud for cost
  assert.equal(odd.origin, 'app')
  assert.deepEqual(Object.keys(odd).sort(), USAGE_FIELDS.filter((f) => f !== 'createdAt').sort())
  for (const value of Object.values(odd)) {
    if (typeof value === 'string') assert.ok(!/Pat|Rivers|Mar 3/.test(value))
  }
})

test('validateUsageEvent refuses extra fields, free text and out-of-range numbers', () => {
  const good = buildUsageEvent(cloudDraft)!
  assert.match(validateUsageEvent({ ...good, note: 'hello' }) ?? '', /unexpected/)
  assert.match(validateUsageEvent({ ...good, label: 'something else' }) ?? '', /label/)
  assert.match(validateUsageEvent({ ...good, model: 'a model with spaces' }) ?? '', /model/)
  assert.match(validateUsageEvent({ ...good, inputTokens: -1 }) ?? '', /token/)
  assert.match(validateUsageEvent({ ...good, outputTokens: 1.5 }) ?? '', /token/)
  assert.match(validateUsageEvent({ ...good, costUsd: 5000 }) ?? '', /cost/)
  assert.match(validateUsageEvent({ ...good, priceVersion: 'today' }) ?? '', /priceVersion/)
  const { label: _label, ...missing } = good
  assert.match(validateUsageEvent(missing) ?? '', /missing field: label/)
})

function row(id: string, minutes: number, input: UsageInput): UsageRow {
  return { ...buildUsageEvent(input)!, id, createdAt: Date.UTC(2026, 10, 24, 9, minutes) }
}

const rows: UsageRow[] = [
  row('a', 0, { label: 'redact', model: '', source: 'on_device', promptChars: 400, outputChars: 100 }),
  row('b', 1, cloudDraft),
  row('c', 75, { ...cloudDraft, usage: { promptTokenCount: 300, candidatesTokenCount: 300 } }),
  row('d', 76, { label: 'tag-case-type', model: '', source: 'on_device', promptChars: 80, outputChars: 8 }),
]

test('totals split cloud from on-device and add up the cost', () => {
  const t = totalUsage(rows)
  assert.equal(t.calls, 4)
  assert.equal(t.cloudCalls, 2)
  assert.equal(t.onDeviceCalls, 2)
  assert.equal(t.cloudTokens, 342 + 420 + 2429 + 600)
  assert.equal(t.totalTokens, t.cloudTokens + 100 + 25 + 20 + 2)
  assert.equal(t.estimatedCalls, 2)
  assert.ok(Math.abs(t.costUsd - ((342 * 1.5 + 2849 * 7.5) + (300 * 1.5 + 300 * 7.5)) / 1e6) < 1e-12)
})

test('groups are sorted by cost, then tokens', () => {
  const byLabel = groupUsage(rows, 'label')
  assert.deepEqual(byLabel.map((g) => g.key), ['draft', 'redact', 'tag-case-type'])
  assert.equal(byLabel[0].calls, 2)
  assert.deepEqual(groupUsage(rows, 'ranOn').map((g) => g.key), ['in_cloud', 'on_device'])
})

test('the timeline fills empty buckets and leaves out rows with no time yet', () => {
  const hour = 60 * 60 * 1000
  const timeline = usageTimeline([...rows, { ...rows[1], id: 'pending', createdAt: null }], hour)
  assert.equal(timeline.length, 2) // 09:00 and 10:00
  assert.equal(timeline[0].calls, 2)
  assert.equal(timeline[1].calls, 2)
  assert.equal(timeline[0].onDeviceTokens, 125)
  assert.equal(usageTimeline([], hour).length, 0)
  // Only the newest maxBuckets buckets are kept.
  assert.equal(usageTimeline(rows, 60 * 1000, 3).length, 3)
})

// --- firestore.rules must allow exactly this shape ------------------------------------------------

const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')

function rulesList(name: string): string[] {
  const body = new RegExp(`function ${name}\\(\\) \\{\\s*return \\[([^\\]]*)\\];`).exec(rules)?.[1]
  assert.ok(body !== undefined, `firestore.rules should define ${name}()`)
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

test('firestore.rules allows exactly the fields and labels that usage.ts uses', () => {
  assert.deepEqual(rulesList('usageFields'), [...USAGE_FIELDS])
  assert.deepEqual(rulesList('usageLabels'), [...USAGE_LABELS])
  assert.deepEqual(rulesList('usagePlaces'), [...USAGE_PLACES])
  assert.deepEqual(rulesList('usageOrigins'), [...USAGE_ORIGINS])
})

test('firestore.rules uses the same patterns as usage.ts and keeps usage records append-only', () => {
  const body = /function validUsageEvent\(e\) \{([\s\S]*?)\n {4}\}/.exec(rules)?.[1] ?? ''
  const patterns = [...body.matchAll(/\.matches\('([^']*)'\)/g)].map((m) => m[1])
  assert.equal(patterns.length, 2)
  assert.equal(patterns[0], USAGE_MODEL_PATTERN.source)
  assert.equal(new RegExp(patterns[1]).test(PRICE_VERSION), true)
  assert.equal(PRICE_VERSION_PATTERN.test(PRICE_VERSION), true)
  assert.match(body, /e\.createdAt == request\.time/)
  assert.match(rules, /match \/usageEvents\/\{eventId\} \{\s*allow read: if request\.auth != null;\s*allow create: if request\.auth != null && validUsageEvent\(request\.resource\.data\);\s*allow update, delete: if false;/)
})
