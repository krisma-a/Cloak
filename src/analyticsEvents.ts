// What Cloak tells Firebase Analytics. Pure: no Firebase here, so `npm test` can check it.
//
// COUNTS ONLY. Five events, each with a fixed list of fields. Every value is rebuilt from a number, a fixed
// word or a strictly shaped code, so nothing a caller hands in (note text, names, file names, a redacted value,
// an error message) can end up in an event. Unknown events and unknown fields are dropped.

import { TEMPLATES } from './ai/templates.ts'
import { safeLanguageCode } from './workspace/language.ts'

type FieldKind =
  | { kind: 'count' }
  | { kind: 'word'; allowed: readonly string[]; fallback: string }
  | { kind: 'model' }
  | { kind: 'lang' }

const ENGINES = ['nano', 'browser-model', 'rules-only'] as const
/** The fixed reasons a send can be refused. Anything else is "other". See blockReasonCode(). */
export const BLOCK_REASONS = [
  'redaction_blocked',
  'names_unchecked',
  'leak_found',
  'medical_blocked',
  'not_approved',
  'restrictions',
  'receipt_failed',
  'other',
] as const

const SPEC = {
  redact_done: {
    engine: { kind: 'word', allowed: ENGINES, fallback: 'other' },
    details_hidden: { kind: 'count' },
  },
  draft_done: {
    template: { kind: 'word', allowed: Object.keys(TEMPLATES), fallback: 'other' },
    model: { kind: 'model' },
  },
  send_blocked: {
    reason: { kind: 'word', allowed: BLOCK_REASONS, fallback: 'other' },
  },
  scan_done: {
    pages: { kind: 'count' },
    rechecked_fixed: { kind: 'count' },
  },
  language_fallback: {
    lang: { kind: 'lang' },
  },
} as const satisfies Record<string, Record<string, FieldKind>>

export type AnalyticsEventName = keyof typeof SPEC

export interface AnalyticsEvent {
  name: AnalyticsEventName
  params: Record<string, string | number>
}

/** The fields each event may carry, for the test. */
export function allowedFields(name: AnalyticsEventName): string[] {
  return Object.keys(SPEC[name])
}

function clean(field: FieldKind, value: unknown): string | number {
  switch (field.kind) {
    case 'count':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 10_000) : 0
    case 'word':
      return typeof value === 'string' && field.allowed.includes(value) ? value : field.fallback
    case 'model':
      // Only a Gemini model name, like "gemini-3.6-flash" or "models/gemini-3.6-flash". An ID-shaped string is not one.
      return typeof value === 'string' && /^(models\/)?gemini-[a-z0-9.-]{1,40}$/.test(value) ? value : 'unknown'
    case 'lang':
      return safeLanguageCode(typeof value === 'string' ? value : null)
  }
}

/** Builds an event from fixed fields only. Returns null for a name that isn't one of the five. */
export function buildAnalyticsEvent(name: string, params: Record<string, unknown> = {}): AnalyticsEvent | null {
  if (!Object.hasOwn(SPEC, name)) return null
  const spec: Record<string, FieldKind> = SPEC[name as AnalyticsEventName]
  const out: Record<string, string | number> = {}
  for (const [key, field] of Object.entries(spec)) out[key] = clean(field, params[key])
  return { name: name as AnalyticsEventName, params: out }
}

/**
 * Turns a refused send's message into one of the fixed reasons. The message itself is never kept: some of them
 * quote a private detail ("contains a private detail ..."), so only the matching word is used.
 */
export function blockReasonCode(message: string): (typeof BLOCK_REASONS)[number] {
  const text = message.toLowerCase()
  if (text.includes('redaction is blocked')) return 'redaction_blocked'
  if (text.includes('names have not been checked')) return 'names_unchecked'
  if (text.includes('leak re-check')) return 'leak_found'
  if (text.includes('medical mode')) return 'medical_blocked'
  if (text.includes('not approved')) return 'not_approved'
  if (text.includes('receipt')) return 'receipt_failed'
  if (text.includes('restriction') || text.includes('which employee')) return 'restrictions'
  return 'other'
}
