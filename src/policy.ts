// Runtime settings that change WITHOUT a redeploy (Firebase Remote Config).
// Pure (no Firebase), so tests run in Node. src/remoteConfig.ts fetches the raw values and calls
// applyRawPolicy(); the redaction, guard and drafting code only ever call getPolicy() at the moment
// they run, so a change in the Firebase console takes effect on the next action.
//
// A value that is missing keeps its default. A value that is present but unreadable fails toward
// MORE privacy (salary stays hidden, medical mode becomes "block"), never less.

export const POLICY_KEYS = ['redact_salary', 'medical_mode', 'max_retries', 'cloud_model', 'cloud_drafts_enabled'] as const
export type PolicyKey = (typeof POLICY_KEYS)[number]

export const MEDICAL_MODES = ['generalize', 'block'] as const
export type MedicalMode = (typeof MEDICAL_MODES)[number]

export interface Policy {
  /** true: salary and pay are hidden. false: they are left visible (and the leak check allows them). */
  redact_salary: boolean
  /** "generalize": medical details become [MEDICAL_DETAIL_n] and work restrictions. "block": a note with medical details is not sent. */
  medical_mode: MedicalMode
  /** How many times on-device redaction may retry before it gives up and blocks. */
  max_retries: number
  /** Cloud Gemini model used for drafting and (as the fallback) tagging. */
  cloud_model: string
  /**
   * The kill switch for cloud drafting. false: no cloud call is made and "Write the draft" is paused. Hiding, review and
   * scanning still work, because they run on this laptop. A missing value means true (the default).
   */
  cloud_drafts_enabled: boolean
}

export const DEFAULT_POLICY: Policy = {
  redact_salary: true,
  medical_mode: 'generalize',
  max_retries: 2,
  cloud_model: 'gemini-3.6-flash',
  cloud_drafts_enabled: true,
}

/** Upper bound for max_retries: every retry is another on-device model call. */
export const MAX_RETRIES_LIMIT = 5

export type RawPolicy = Partial<Record<PolicyKey, string>>

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off'])
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/

/** Turns raw strings (Remote Config values are strings) into a safe Policy plus notes about anything odd. */
export function parsePolicy(raw: RawPolicy, defaults: Policy = DEFAULT_POLICY): { policy: Policy; warnings: string[] } {
  const policy: Policy = { ...defaults }
  const warnings: string[] = []
  const given = (key: PolicyKey): string | null => {
    const value = raw[key]
    return value === undefined || value.trim() === '' ? null : value.trim()
  }

  const salary = given('redact_salary')
  if (salary !== null) {
    const word = salary.toLowerCase()
    if (TRUE_WORDS.has(word)) policy.redact_salary = true
    else if (FALSE_WORDS.has(word)) policy.redact_salary = false
    else {
      policy.redact_salary = true
      warnings.push(`redact_salary "${salary}" is not true or false, so salary stays hidden`)
    }
  }

  const medical = given('medical_mode')
  if (medical !== null) {
    const mode = medical.toLowerCase()
    if ((MEDICAL_MODES as readonly string[]).includes(mode)) policy.medical_mode = mode as MedicalMode
    else {
      policy.medical_mode = 'block'
      warnings.push(`medical_mode "${medical}" is not "generalize" or "block", so medical notes are blocked`)
    }
  }

  const retries = given('max_retries')
  if (retries !== null) {
    const n = Number(retries)
    if (!Number.isInteger(n)) {
      warnings.push(`max_retries "${retries}" is not a whole number, so ${defaults.max_retries} is used`)
    } else if (n < 0) {
      policy.max_retries = 0
      warnings.push(`max_retries ${n} is below 0, so 0 is used`)
    } else if (n > MAX_RETRIES_LIMIT) {
      policy.max_retries = MAX_RETRIES_LIMIT
      warnings.push(`max_retries ${n} is above ${MAX_RETRIES_LIMIT}, so ${MAX_RETRIES_LIMIT} is used`)
    } else policy.max_retries = n
  }

  const model = given('cloud_model')
  if (model !== null) {
    if (MODEL_NAME.test(model)) policy.cloud_model = model
    else warnings.push(`cloud_model "${model}" is not a valid model name, so ${defaults.cloud_model} is used`)
  }

  // The kill switch. Missing keeps the default (true). A value that can't be read pauses drafting: like the other
  // settings, the doubt goes toward more privacy, and a typo is easy to spot and fix in the console.
  const drafts = given('cloud_drafts_enabled')
  if (drafts !== null) {
    const word = drafts.toLowerCase()
    if (TRUE_WORDS.has(word)) policy.cloud_drafts_enabled = true
    else if (FALSE_WORDS.has(word)) policy.cloud_drafts_enabled = false
    else {
      policy.cloud_drafts_enabled = false
      warnings.push(`cloud_drafts_enabled "${drafts}" is not true or false, so cloud drafting is paused`)
    }
  }

  return { policy, warnings }
}

// ---------------------------------------------------------------------------------------------
// The live store

export type PolicySource = 'defaults' | 'remote'

export interface PolicyStatus {
  /** "remote": at least one value came from Remote Config. "defaults": built-in values only. */
  source: PolicySource
  /** When the settings were last fetched (ms since 1970), or null if never. */
  fetchedAt: number | null
  warnings: string[]
  /** Why Remote Config could not be used, or null. */
  error: string | null
  /** "on": the server pushes changes. "polling": checking every 30 s. "off": only the fetch at load. */
  live: 'off' | 'on' | 'polling'
}

export interface PolicySnapshot {
  policy: Policy
  status: PolicyStatus
}

let defaults: Policy = { ...DEFAULT_POLICY }
let snapshot: PolicySnapshot = freshSnapshot()
let ready: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function freshSnapshot(): PolicySnapshot {
  return {
    policy: { ...defaults },
    status: { source: 'defaults', fetchedAt: null, warnings: [], error: null, live: 'off' },
  }
}

function publish(next: PolicySnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

/** The settings in force right now. Call it when you need a value; do not keep the result around. */
export function getPolicy(): Policy {
  return snapshot.policy
}

/** Same object until something changes (for React's useSyncExternalStore). */
export function getPolicySnapshot(): PolicySnapshot {
  return snapshot
}

export function subscribePolicy(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The built-in defaults (they can differ from DEFAULT_POLICY, e.g. VITE_CLOUD_MODEL). */
export function getPolicyDefaults(): Policy {
  return defaults
}

/** Changes the built-in defaults. Used before Remote Config has answered (and when it never does). */
export function setPolicyDefaults(raw: RawPolicy): void {
  defaults = parsePolicy(raw, defaults).policy
  if (snapshot.status.source === 'defaults') publish({ ...snapshot, policy: { ...defaults } })
}

/** Applies raw Remote Config values. Returns the notes about anything it had to correct. */
export function applyRawPolicy(raw: RawPolicy, meta: { source: PolicySource; fetchedAt?: number | null }): string[] {
  const { policy, warnings } = parsePolicy(raw, defaults)
  publish({
    policy,
    status: {
      ...snapshot.status,
      source: meta.source,
      fetchedAt: meta.fetchedAt === undefined ? snapshot.status.fetchedAt : meta.fetchedAt,
      warnings,
    },
  })
  return warnings
}

export function setPolicyStatus(patch: Partial<PolicyStatus>): void {
  publish({ ...snapshot, status: { ...snapshot.status, ...patch } })
}

/** Registers the first fetch, so redact() and draft() wait for it (briefly) instead of racing it. */
export function expectPolicyLoad(load: Promise<unknown>): void {
  ready = load.then(
    () => undefined,
    () => undefined,
  )
}

/** Resolves when the first fetch has finished or failed. Resolves at once if none was registered. */
export function whenPolicyReady(): Promise<void> {
  return ready
}

/** Back to the built-in defaults. For tests. */
export function resetPolicy(): void {
  defaults = { ...DEFAULT_POLICY }
  snapshot = freshSnapshot()
  ready = Promise.resolve()
  for (const listener of listeners) listener()
}
