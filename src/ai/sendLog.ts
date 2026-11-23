// The send log: one small record per send, saved to Firestore at users/{uid}/sendLogs/{id}.
// Pure (no Firebase), so tests run in Node. The Firestore code is sendLogStore.ts; the rules are in
// firestore.rules and use the same lists as this file (a test keeps them in step).
//
// A record holds NUMBERS and FIXED LABELS only: how many details of each kind were hidden, whether the
// send was blocked, which settings and model were in force, and where each step ran. It never holds
// text from a case: no note, no name, no placeholder map, no error message. To make sure of that,
// buildSendLog() REBUILDS the record from fixed lists. It never copies a string it was given unless
// that string matches a strict pattern (a hash, a model name, a user id).

import { PLACEHOLDER_PREFIXES } from './placeholders.ts'

export const SEND_LOG_SCHEMA = 1

/** The steps of a send, as ReceiptStep names them. */
export const LOG_STEPS = ['redaction', 'names', 'cross-check', 'restrictions', 'drafting', 'restore'] as const
/** Where a step can run. */
export const LOG_PLACES = ['on_device', 'in_browser', 'rules', 'in_cloud'] as const
/** Every field of a stored record, including the server time added when it is saved. */
export const SEND_LOG_FIELDS = ['userId', 'createdAt', 'schema', 'blocked', 'counts', 'settingsVersion', 'model', 'ranOn'] as const

export const MAX_COUNT = 100_000
/** A SHA-256 of the Remote Config values (see receiptLog.ts), or "unknown". */
export const SETTINGS_VERSION_PATTERN = /^(?:[0-9a-f]{64}|unknown)$/
/** Same shape policy.ts accepts for cloud_model. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/
/** A Firebase Auth uid. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type LogStep = (typeof LOG_STEPS)[number]
export type LogPlace = (typeof LOG_PLACES)[number]

export interface SendLogRecord {
  /** The signed-in user. Firestore rules require it to match the path and the signed-in user. */
  userId: string
  schema: typeof SEND_LOG_SCHEMA
  /** True when the send was refused (nothing went to the cloud). */
  blocked: boolean
  /** Hidden details per placeholder prefix, e.g. { EMPLOYEE: 3, SALARY: 1 }. Only prefixes that occur. */
  counts: Record<string, number>
  /** A fingerprint of the four Remote Config settings in force, or "unknown". */
  settingsVersion: string
  /** The cloud model for this send, or null when the send was blocked before a model was chosen. */
  model: string | null
  /** Where each step ran. Only the steps that happened. */
  ranOn: Partial<Record<LogStep, LogPlace>>
}

export interface SendLogInput {
  userId: string
  blocked: boolean
  counts: Record<string, number>
  settingsVersion: string
  model: string | null
  steps: ReadonlyArray<{ step: string; ranOn: string }>
}

const isStep = (value: string): value is LogStep => (LOG_STEPS as readonly string[]).includes(value)
const isPlace = (value: string): value is LogPlace => (LOG_PLACES as readonly string[]).includes(value)

/** Builds the record to save. Anything that is not on a fixed list or does not match a strict pattern is dropped. */
export function buildSendLog(input: SendLogInput): SendLogRecord {
  if (!USER_ID_PATTERN.test(input.userId)) throw new Error('A send log needs a valid user id.')

  const counts: Record<string, number> = {}
  for (const prefix of PLACEHOLDER_PREFIXES) {
    const n = input.counts[prefix]
    if (Number.isInteger(n) && n > 0 && n <= MAX_COUNT) counts[prefix] = n
  }

  const ranOn: Partial<Record<LogStep, LogPlace>> = {}
  for (const { step, ranOn: place } of input.steps) {
    if (isStep(step) && isPlace(place)) ranOn[step] = place
  }

  return {
    userId: input.userId,
    schema: SEND_LOG_SCHEMA,
    blocked: input.blocked === true,
    counts,
    settingsVersion: SETTINGS_VERSION_PATTERN.test(input.settingsVersion) ? input.settingsVersion : 'unknown',
    model: input.model !== null && MODEL_PATTERN.test(input.model) ? input.model : null,
    ranOn,
  }
}

/**
 * Checks a record is exactly the shape above, with nothing extra. Returns what is wrong, or null.
 * The message never repeats a value. Used before saving and when reading logs back.
 */
export function validateSendLog(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object'
  const record = value as Record<string, unknown>
  const allowed: readonly string[] = SEND_LOG_FIELDS.filter((field) => field !== 'createdAt')
  const extra = Object.keys(record).filter((key) => !allowed.includes(key))
  if (extra.length) return `unexpected field (${extra.length})`
  const missing = allowed.filter((key) => !(key in record))
  if (missing.length) return `missing field: ${missing.join(', ')}`

  if (typeof record.userId !== 'string' || !USER_ID_PATTERN.test(record.userId)) return 'userId is not a user id'
  if (record.schema !== SEND_LOG_SCHEMA) return 'schema is not the current version'
  if (typeof record.blocked !== 'boolean') return 'blocked is not true or false'
  if (typeof record.settingsVersion !== 'string' || !SETTINGS_VERSION_PATTERN.test(record.settingsVersion)) {
    return 'settingsVersion is not a fingerprint'
  }
  if (record.model !== null && (typeof record.model !== 'string' || !MODEL_PATTERN.test(record.model))) {
    return 'model is not a model name'
  }

  const counts = record.counts
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return 'counts is not a map'
  for (const [key, n] of Object.entries(counts)) {
    if (!PLACEHOLDER_PREFIXES.includes(key)) return 'counts has an unknown category'
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_COUNT) return 'a count is not a small whole number'
  }

  const ranOn = record.ranOn
  if (typeof ranOn !== 'object' || ranOn === null || Array.isArray(ranOn)) return 'ranOn is not a map'
  for (const [step, place] of Object.entries(ranOn)) {
    if (!isStep(step)) return 'ranOn has an unknown step'
    if (typeof place !== 'string' || !isPlace(place)) return 'ranOn has an unknown place'
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// CSV

/** A stored record plus its id and time (an ISO string, or null if the server time is not there yet). */
export interface SendLogRow extends SendLogRecord {
  id: string
  createdAt: string | null
}

export const CSV_COLUMNS: readonly string[] = [
  'created_at',
  'user_id',
  'blocked',
  'settings_version',
  'model',
  ...PLACEHOLDER_PREFIXES.map((prefix) => `count_${prefix.toLowerCase()}`),
  ...LOG_STEPS.map((step) => `ran_${step.replace('-', '_')}`),
]

function cell(value: string | number | boolean | null): string {
  if (value === null) return ''
  if (typeof value !== 'string') return String(value)
  // A cell that starts with = + - @ is read as a formula by spreadsheets, so mark it as plain text.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** The logs as CSV (RFC 4180: comma-separated, CRLF line ends). One row per send; a count of 0 where a kind did not occur. */
export function sendLogsToCsv(rows: readonly SendLogRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(
      [
        cell(row.createdAt),
        cell(row.userId),
        cell(row.blocked),
        cell(row.settingsVersion),
        cell(row.model),
        ...PLACEHOLDER_PREFIXES.map((prefix) => cell(row.counts[prefix] ?? 0)),
        ...LOG_STEPS.map((step) => cell(row.ranOn[step] ?? null)),
      ].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
