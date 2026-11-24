// Token and cost tracking: one small record per model call, saved to Firestore at usageEvents/{id}.
// Pure (no Firebase), so tests run in Node. The Firestore code is usageStore.ts; the rules are in
// firestore.rules and use the same lists as this file (usage.test.ts keeps them in step).
//
// A record holds NUMBERS and FIXED LABELS only: which step called a model, which model, where it ran,
// how many tokens went in and out, and what that would cost on the paid tier. No text from a case, no
// prompt, no reply, no user id. buildUsageEvent() REBUILDS the record from fixed lists, like sendLog.ts.

export const USAGE_SCHEMA = 1

/** The labels generateLogged() is called with (inference.ts). */
export const USAGE_LABELS = ['redact', 'restrictions', 'tag-case-type', 'rewrite-tone', 'draft'] as const
/** Where a call ran, as the Firebase SDK reports it. */
export const USAGE_PLACES = ['on_device', 'in_cloud'] as const
/** Which page made the call: the app itself, or the /eval page. */
export const USAGE_ORIGINS = ['app', 'eval'] as const
/** Every field of a stored record, including the server time added when it is saved. */
export const USAGE_FIELDS = [
  'schema', 'origin', 'label', 'model', 'ranOn', 'inputTokens', 'outputTokens', 'thinkingTokens', 'estimated', 'costUsd',
  'priceVersion', 'createdAt',
] as const

export const MAX_TOKENS = 10_000_000
export const MAX_COST_USD = 1000
/** Same shape policy.ts accepts for cloud_model. */
export const USAGE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/
export const PRICE_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** The name recorded for Gemini Nano (the SDK gives on-device calls no model name of their own). */
export const ON_DEVICE_MODEL = 'gemini-nano'

export type UsageLabel = (typeof USAGE_LABELS)[number]
export type UsagePlace = (typeof USAGE_PLACES)[number]
export type UsageOrigin = (typeof USAGE_ORIGINS)[number]

// ---------------------------------------------------------------------------------------------
// Prices

/** USD per 1 million tokens on the paid tier. Thinking tokens are billed as output. */
export interface Price {
  inputPerM: number
  outputPerM: number
}

/** The day these prices were checked. Stored on every record, so old records keep the price they were worked out with. */
export const PRICE_VERSION = '2026-11-24'

/**
 * Standard paid-tier prices, checked 2026-11-24 (ai.google.dev/pricing, deepmind.google/models/gemini/flash).
 * Vertex AI lists an introductory $0.75 / $3.75 for gemini-3.6-flash until 2026-12-31, so the real bill can be
 * lower. On the free tier the real bill is $0: these are "what it would cost" figures.
 * A model that is not listed gets no price (costUsd null) instead of a guess.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  'gemini-3.6-flash': { inputPerM: 1.5, outputPerM: 7.5 },
}

/** On-device calls cost nothing. Cloud calls cost tokens × price, or null when the model has no price. */
export function costUsd(model: string, place: UsagePlace, tokens: { input: number; output: number; thinking: number }): number | null {
  if (place === 'on_device') return 0
  const price = PRICES[model]
  if (!price) return null
  return (tokens.input * price.inputPerM + (tokens.output + tokens.thinking) * price.outputPerM) / 1_000_000
}

// ---------------------------------------------------------------------------------------------
// Which page is calling

let origin: UsageOrigin = 'app'

/** The /eval page calls this so its calls can be told apart from real use. */
export function setUsageOrigin(value: UsageOrigin): void {
  origin = value
}

export function usageOrigin(): UsageOrigin {
  return origin
}

// ---------------------------------------------------------------------------------------------
// Building and checking a record

export interface UsageEvent {
  schema: typeof USAGE_SCHEMA
  origin: UsageOrigin
  label: UsageLabel
  model: string
  ranOn: UsagePlace
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  /** True when the SDK reported no token counts and they were estimated from the length (about 4 characters a token). */
  estimated: boolean
  /** What the call would cost on the paid tier, in USD. 0 on device. Null when the model has no listed price. */
  costUsd: number | null
  priceVersion: string
}

export interface UsageInput {
  label: string
  /** The SDK's model name, e.g. "models/gemini-3.6-flash". Ignored for on-device calls. */
  model: string
  /** The SDK's inferenceSource: "on_device", "in_cloud", or anything else (treated as cloud). */
  source: string
  /** The SDK's usageMetadata, when it reports one. */
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | null
  /** Lengths only, used to estimate tokens when the SDK reports none. Never the text itself. */
  promptChars: number
  outputChars: number
  origin?: UsageOrigin
}

const isLabel = (value: string): value is UsageLabel => (USAGE_LABELS as readonly string[]).includes(value)
const isPlace = (value: string): value is UsagePlace => (USAGE_PLACES as readonly string[]).includes(value)
const isOrigin = (value: string): value is UsageOrigin => (USAGE_ORIGINS as readonly string[]).includes(value)

const tokenCount = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(MAX_TOKENS, Math.round(n)) : null
const estimate = (chars: number): number => Math.min(MAX_TOKENS, Math.ceil(Math.max(0, chars) / 4))

/** Builds the record to save, or null for a label that is not on the list. Nothing outside the fixed lists gets in. */
export function buildUsageEvent(input: UsageInput): UsageEvent | null {
  if (!isLabel(input.label)) return null
  // "unknown" means the SDK did not say. Only ONLY_IN_CLOUD and PREFER_ON_DEVICE calls can leave the device,
  // so counting an unknown call as cloud is the cautious choice for cost.
  const ranOn: UsagePlace = isPlace(input.source) ? input.source : 'in_cloud'
  const cloudName = input.model.replace(/^models\//, '')
  const model = ranOn === 'on_device' ? ON_DEVICE_MODEL : USAGE_MODEL_PATTERN.test(cloudName) ? cloudName : 'unknown'

  const reportedIn = tokenCount(input.usage?.promptTokenCount)
  const reportedOut = tokenCount(input.usage?.candidatesTokenCount)
  const estimated = reportedIn === null || reportedOut === null
  const tokens = {
    input: reportedIn ?? estimate(input.promptChars),
    output: reportedOut ?? estimate(input.outputChars),
    thinking: tokenCount(input.usage?.thoughtsTokenCount) ?? 0,
  }
  const cost = costUsd(model, ranOn, tokens)

  return {
    schema: USAGE_SCHEMA,
    origin: input.origin !== undefined && isOrigin(input.origin) ? input.origin : 'app',
    label: input.label,
    model,
    ranOn,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    thinkingTokens: tokens.thinking,
    estimated,
    costUsd: cost === null ? null : Math.min(MAX_COST_USD, cost),
    priceVersion: PRICE_VERSION,
  }
}

const isTokens = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_TOKENS

/** Checks a record is exactly the shape above, with nothing extra. Returns what is wrong, or null. Never repeats a value. */
export function validateUsageEvent(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object'
  const record = value as Record<string, unknown>
  const allowed: readonly string[] = USAGE_FIELDS.filter((field) => field !== 'createdAt')
  if (Object.keys(record).some((key) => !allowed.includes(key))) return 'unexpected field'
  const missing = allowed.filter((key) => !(key in record))
  if (missing.length) return `missing field: ${missing.join(', ')}`
  if (record.schema !== USAGE_SCHEMA) return 'schema is not the current version'
  if (typeof record.origin !== 'string' || !isOrigin(record.origin)) return 'origin is not on the list'
  if (typeof record.label !== 'string' || !isLabel(record.label)) return 'label is not on the list'
  if (typeof record.ranOn !== 'string' || !isPlace(record.ranOn)) return 'ranOn is not on the list'
  if (typeof record.model !== 'string' || !USAGE_MODEL_PATTERN.test(record.model)) return 'model is not a model name'
  if (!isTokens(record.inputTokens) || !isTokens(record.outputTokens) || !isTokens(record.thinkingTokens)) {
    return 'a token count is not a whole number in range'
  }
  if (typeof record.estimated !== 'boolean') return 'estimated is not true or false'
  const cost = record.costUsd
  if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > MAX_COST_USD)) {
    return 'costUsd is not a price in range'
  }
  if (typeof record.priceVersion !== 'string' || !PRICE_VERSION_PATTERN.test(record.priceVersion)) return 'priceVersion is not a date'
  return null
}

// ---------------------------------------------------------------------------------------------
// Summaries for the dashboard

/** A stored record plus its id and time (ms since 1970, or null while the server time is pending). */
export interface UsageRow extends UsageEvent {
  id: string
  createdAt: number | null
}

export interface UsageTotals {
  calls: number
  cloudCalls: number
  onDeviceCalls: number
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  totalTokens: number
  /** Cloud tokens only (input + output + thinking). */
  cloudTokens: number
  costUsd: number
  /** Calls whose tokens were estimated from the length. */
  estimatedCalls: number
  /** Cloud calls with no listed price (not in costUsd). */
  unpricedCalls: number
}

export interface UsageGroup extends UsageTotals {
  key: string
}

export interface UsageBucket {
  /** Start of the bucket, ms since 1970. */
  start: number
  cloudTokens: number
  onDeviceTokens: number
  costUsd: number
  calls: number
}

const emptyTotals = (): UsageTotals => ({
  calls: 0, cloudCalls: 0, onDeviceCalls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0,
  cloudTokens: 0, costUsd: 0, estimatedCalls: 0, unpricedCalls: 0,
})

const rowTokens = (row: UsageEvent): number => row.inputTokens + row.outputTokens + row.thinkingTokens

function addRow(totals: UsageTotals, row: UsageEvent): void {
  const tokens = rowTokens(row)
  totals.calls++
  if (row.ranOn === 'in_cloud') {
    totals.cloudCalls++
    totals.cloudTokens += tokens
    if (row.costUsd === null) totals.unpricedCalls++
  } else {
    totals.onDeviceCalls++
  }
  totals.inputTokens += row.inputTokens
  totals.outputTokens += row.outputTokens
  totals.thinkingTokens += row.thinkingTokens
  totals.totalTokens += tokens
  totals.costUsd += row.costUsd ?? 0
  if (row.estimated) totals.estimatedCalls++
}

export function totalUsage(rows: readonly UsageEvent[]): UsageTotals {
  const totals = emptyTotals()
  for (const row of rows) addRow(totals, row)
  return totals
}

/** Totals per label, model, place or origin, biggest cost first (then most tokens). */
export function groupUsage(rows: readonly UsageEvent[], by: 'label' | 'model' | 'ranOn' | 'origin'): UsageGroup[] {
  const groups = new Map<string, UsageGroup>()
  for (const row of rows) {
    const key = row[by]
    const group = groups.get(key) ?? { key, ...emptyTotals() }
    addRow(group, row)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || a.key.localeCompare(b.key))
}

/**
 * Tokens and cost per time bucket, oldest first, with empty buckets filled in so a chart shows the gaps.
 * Rows still waiting for their server time are left out. At most `maxBuckets` buckets (the newest).
 */
export function usageTimeline(rows: readonly UsageRow[], bucketMs: number, maxBuckets = 48): UsageBucket[] {
  const timed = rows.filter((row) => row.createdAt !== null)
  if (timed.length === 0 || bucketMs <= 0) return []
  const startOf = (t: number) => Math.floor(t / bucketMs) * bucketMs
  const last = startOf(Math.max(...timed.map((row) => row.createdAt as number)))
  const first = Math.max(startOf(Math.min(...timed.map((row) => row.createdAt as number))), last - (maxBuckets - 1) * bucketMs)
  const buckets = new Map<number, UsageBucket>()
  for (let t = first; t <= last; t += bucketMs) buckets.set(t, { start: t, cloudTokens: 0, onDeviceTokens: 0, costUsd: 0, calls: 0 })
  for (const row of timed) {
    const bucket = buckets.get(startOf(row.createdAt as number))
    if (!bucket) continue // older than the window
    bucket.calls++
    if (row.ranOn === 'in_cloud') bucket.cloudTokens += rowTokens(row)
    else bucket.onDeviceTokens += rowTokens(row)
    bucket.costUsd += row.costUsd ?? 0
  }
  return [...buckets.values()]
}
