// Firebase Remote Config: the four runtime settings (redact_salary, medical_mode, max_retries,
// cloud_model). The meaning, defaults and validation live in src/policy.ts; this file only fetches.
//
//   1. On load: the built-in defaults apply at once, then the values are fetched and activated.
//   2. Live: when someone publishes a change in the Firebase console, the server pushes it
//      (onConfigUpdate) and it applies within seconds, no reload. If that stream is unavailable
//      the app checks every 30 s instead.
//   3. If Remote Config can't be used at all (offline, no .env.local, blocked), the built-in
//      defaults stay in force and the app keeps working.
//
// Only setting values pass through here: never note text, names or drafts.

import {
  activate,
  fetchAndActivate,
  getAll,
  getRemoteConfig,
  isSupported,
  onConfigUpdate,
  type RemoteConfig,
} from 'firebase/remote-config'
import { app } from './firebase'
import { applyRawPolicy, getPolicy, getPolicyDefaults, POLICY_KEYS, setPolicyStatus, type RawPolicy } from './policy.ts'

// How long a fetched value may be reused before the load-time fetch asks the server again.
const FETCH_INTERVAL_MS = import.meta.env.DEV ? 10_000 : 60_000
const FETCH_TIMEOUT_MS = 5_000
const POLL_MS = 30_000

let remote: RemoteConfig | undefined
let started: Promise<void> | undefined
let poller: ReturnType<typeof setInterval> | undefined

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Reads the activated values into the live policy and logs what changed (settings only). */
function apply(rc: RemoteConfig): void {
  const before = getPolicy()
  const all = getAll(rc)
  const raw: RawPolicy = {}
  let fromRemote = false
  for (const key of POLICY_KEYS) {
    const value = all[key]
    if (!value) continue
    raw[key] = value.asString()
    if (value.getSource() === 'remote') fromRemote = true
  }
  const warnings = applyRawPolicy(raw, {
    source: fromRemote ? 'remote' : 'defaults',
    fetchedAt: rc.fetchTimeMillis > 0 ? rc.fetchTimeMillis : null,
  })
  const after = getPolicy()
  const changed = POLICY_KEYS.filter((k) => before[k] !== after[k]).map((k) => `${k}: ${before[k]} -> ${after[k]}`)
  if (changed.length) console.info(`[policy] updated: ${changed.join(', ')}`)
  for (const warning of warnings) console.warn(`[policy] ${warning}`)
}

function startPolling(): void {
  setPolicyStatus({ live: 'polling' })
  if (poller === undefined) poller = setInterval(() => void refreshRemoteConfig(), POLL_MS)
}

function listenForChanges(rc: RemoteConfig): void {
  try {
    onConfigUpdate(rc, {
      // The server already fetched the new values; activating makes them current.
      next: () => {
        activate(rc).then(
          () => apply(rc),
          (e) => setPolicyStatus({ error: `Could not apply the new settings (${describe(e)}).` }),
        )
      },
      error: (e) => {
        console.warn(`[policy] live updates stopped (${describe(e)}); checking every ${POLL_MS / 1000} s instead`)
        startPolling()
      },
      complete: () => {},
    })
    setPolicyStatus({ live: 'on' })
  } catch (e) {
    console.warn(`[policy] live updates unavailable (${describe(e)}); checking every ${POLL_MS / 1000} s instead`)
    startPolling()
  }
}

/** Fetches now, ignoring the usual wait between fetches. For the "Fetch now" button and the polling fallback. */
export async function refreshRemoteConfig(): Promise<void> {
  const rc = remote
  if (!rc) return
  const wait = rc.settings.minimumFetchIntervalMillis
  rc.settings.minimumFetchIntervalMillis = 0
  try {
    await fetchAndActivate(rc)
    setPolicyStatus({ error: null })
  } catch (e) {
    setPolicyStatus({ error: `Could not fetch settings (${describe(e)}).` })
  } finally {
    rc.settings.minimumFetchIntervalMillis = wait
  }
  apply(rc)
}

/** Starts Remote Config. Safe to call more than once; resolves when the first fetch has finished or failed. */
export function startRemoteConfig(): Promise<void> {
  started ??= (async () => {
    try {
      if (!(await isSupported())) throw new Error('this browser does not support Remote Config')
      const rc = getRemoteConfig(app)
      rc.settings.minimumFetchIntervalMillis = FETCH_INTERVAL_MS
      rc.settings.fetchTimeoutMillis = FETCH_TIMEOUT_MS
      const d = getPolicyDefaults()
      rc.defaultConfig = {
        redact_salary: String(d.redact_salary),
        medical_mode: d.medical_mode,
        max_retries: String(d.max_retries),
        cloud_model: d.cloud_model,
      }
      remote = rc
      apply(rc) // defaults first, so something sensible is in force while the fetch runs
      try {
        await fetchAndActivate(rc)
        setPolicyStatus({ error: null })
      } catch (e) {
        setPolicyStatus({ error: `Could not fetch settings (${describe(e)}). Using the last saved or built-in values.` })
      }
      apply(rc)
      listenForChanges(rc)
    } catch (e) {
      const why = describe(e)
      setPolicyStatus({ error: `Remote Config is not available (${why}). Using built-in values.` })
      console.warn(`[policy] Remote Config is not available (${why}); using built-in values`)
    }
  })()
  return started
}
