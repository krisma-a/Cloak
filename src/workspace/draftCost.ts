// What a draft costs: the receipt for one draft, an estimate before sending, and the history of drafts made on this laptop.
// Pure (no DOM, no Firebase), so tests run in Node. Prices come from usage.ts (PRICES): paid-tier figures. On the free tier
// the real bill is $0, so everything here is "what it would cost". The history holds numbers only (model, token counts,
// cost, time): never any text, and it stays in this browser.

import { costUsd, PRICE_VERSION, PRICES } from '../ai/usage.ts'
import type { UsageEvent } from '../ai/usage.ts'

/** The money-relevant part of one cloud call. */
export type DraftCost = Pick<UsageEvent, 'model' | 'inputTokens' | 'outputTokens' | 'thinkingTokens' | 'estimated' | 'costUsd' | 'priceVersion'>

export const DEFAULT_MODEL = 'gemini-3.6-flash'

/** "$0.0098", "<$0.0001", "$1.23", or an em dash when there's no price. */
export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return '—'
  if (amount === 0) return '$0.00'
  if (amount < 0.0001) return '<$0.0001'
  return amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

export interface ReceiptLine {
  label: string
  tokens: number
  /** USD for this line, or null when the model has no listed price. */
  amount: number | null
}

/** The itemised lines of a draft's bill: what was sent, what was written, and the thinking (billed like written text). */
export function receiptLines(cost: DraftCost): ReceiptLine[] {
  const price = PRICES[cost.model]
  const line = (label: string, tokens: number, perM: number | undefined): ReceiptLine => ({
    label,
    tokens,
    amount: perM === undefined ? null : (tokens * perM) / 1_000_000,
  })
  const lines = [line('Text sent to the cloud', cost.inputTokens, price?.inputPerM), line('Draft written', cost.outputTokens, price?.outputPerM)]
  if (cost.thinkingTokens > 0) lines.push(line('Thinking', cost.thinkingTokens, price?.outputPerM))
  return lines
}

/**
 * About what a draft will cost before it's sent: the text sent is the prompt (about 4 characters a token); the draft
 * written is usually a bit shorter than the notes (350–1400 tokens); thinking is a fixed 500 tokens: a real draft on
 * 2026-11-25 used 622 thinking tokens even at the LOW setting, which was most of its cost. An estimate, labelled as one
 * wherever it's shown.
 */
export function estimateDraftCost(promptChars: number, model = DEFAULT_MODEL): DraftCost {
  const inputTokens = Math.ceil(Math.max(0, promptChars) / 4)
  const outputTokens = Math.min(1400, Math.max(350, Math.round(inputTokens * 0.9)))
  const thinkingTokens = 500
  return {
    model,
    inputTokens,
    outputTokens,
    thinkingTokens,
    estimated: true,
    costUsd: costUsd(model, 'in_cloud', { input: inputTokens, output: outputTokens, thinking: thinkingTokens }),
    priceVersion: PRICE_VERSION,
  }
}

/** A planning figure: `perDraft` USD, `perDay` drafts a day, `days` working days a month. */
export function monthlyCost(perDraft: number, perDay: number, days = 22): number {
  return Math.max(0, perDraft) * Math.max(0, perDay) * days
}

// ---------------------------------------------------------------------------------------------
// History on this laptop

export interface DraftRecord extends DraftCost {
  /** When the draft was made (ms since 1970). */
  at: number
  /** A demo draft: nothing was sent, so nothing was spent (the cost shown is what a real one would cost). */
  demo: boolean
}

const KEY = 'cloak.draftCosts'
export const MAX_RECORDS = 200

const isRecord = (value: unknown): value is DraftRecord => {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.at === 'number' &&
    typeof r.demo === 'boolean' &&
    typeof r.model === 'string' &&
    [r.inputTokens, r.outputTokens, r.thinkingTokens].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (r.costUsd === null || (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)))
  )
}

/** The saved history, oldest first. Anything malformed is dropped; blocked storage gives an empty list. */
export function loadHistory(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): DraftRecord[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isRecord).slice(-MAX_RECORDS) : []
  } catch {
    return []
  }
}

/** Adds one draft to the history (keeping the newest MAX_RECORDS). Numbers only: the fields are picked one by one. */
export function addDraftRecord(
  record: DraftRecord,
  storage: (Pick<Storage, 'getItem' | 'setItem'>) | undefined = globalThis.localStorage,
): void {
  try {
    const clean: DraftRecord = {
      at: record.at,
      demo: record.demo,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      thinkingTokens: record.thinkingTokens,
      estimated: record.estimated,
      costUsd: record.costUsd,
      priceVersion: record.priceVersion,
    }
    storage?.setItem(KEY, JSON.stringify([...loadHistory(storage), clean].slice(-MAX_RECORDS)))
  } catch {
    // Not saved; the draft itself is unaffected.
  }
}

export function clearHistory(storage: Pick<Storage, 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}

export interface HistorySummary {
  /** Real drafts (sent to the cloud) and demo drafts. */
  drafts: number
  demoDrafts: number
  /** What the real drafts would cost on the paid tier, and the average per draft (null with none). */
  total: number
  average: number | null
  /** The cost of the latest real drafts, oldest first, for the small bars. */
  recent: number[]
}

/** Demo drafts are counted but never added to the spend. Drafts with no price are counted but add nothing. */
export function summarizeHistory(records: readonly DraftRecord[], recentCount = 20): HistorySummary {
  const real = records.filter((r) => !r.demo)
  const priced = real.filter((r) => r.costUsd !== null)
  const total = priced.reduce((sum, r) => sum + (r.costUsd as number), 0)
  return {
    drafts: real.length,
    demoDrafts: records.length - real.length,
    total,
    average: priced.length ? total / priced.length : null,
    recent: priced.slice(-recentCount).map((r) => r.costUsd as number),
  }
}
