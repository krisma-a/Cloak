// Local receipts: one record per cloud call, written BEFORE the call and finished after it.
// Pure (no IndexedDB, no Firebase), so tests run in Node. The browser store is receiptStore.ts.
//
// A receipt holds: the exact text sent (already redacted), its SHA-256, the model, the Remote Config
// values in force (a fingerprint and when they were fetched), and for the call: when it started and
// finished, and where it ran (inferenceSource).
// A receipt never holds: the placeholder map, the raw note, names, or restored drafts.

import { getPolicySnapshot, POLICY_KEYS, type Policy, type PolicySource } from '../policy.ts'
import { SendBlockedError } from './errors.ts'
import { sha256Hex } from './receipt.ts'

export type ReceiptStatus = 'pending' | 'done' | 'failed'

export interface CallStep {
  /** 'draft', 'tag-case-type' or 'rewrite-tone'. */
  name: string
  startedAt: string
  finishedAt: string | null
  /** Where the SDK says the call ran: 'on_device', 'in_cloud' or 'unknown'. Null until it finishes. */
  inferenceSource: string | null
}

export interface LocalReceipt {
  id: string
  /** When the call was about to be made (ISO time). */
  createdAt: string
  /**
   * 'pending' is written before the call. It stays pending if the call never finished or the
   * final write failed, so a pending receipt means "started, not confirmed finished".
   */
  status: ReceiptStatus
  /** The exact text sent to the model (for drafts, the full prompt with the redacted notes). */
  sentText: string
  /** SHA-256 of sentText, hex. */
  sha256: string
  /** The cloud model. For tagging and tone the call may still have run on the device (see inferenceSource). */
  model: string
  config: {
    /** SHA-256 of the four Remote Config values in force. The web SDK does not expose the template version number. */
    fingerprint: string
    source: PolicySource
    /** When those values were fetched (ISO time), or null if they were never fetched. */
    fetchedAt: string | null
  }
  steps: CallStep[]
  /** The error name and a short message, if the call failed. */
  error: string | null
}

export interface ReceiptStore {
  put(receipt: LocalReceipt): Promise<void>
  list(): Promise<LocalReceipt[]>
}

export interface CallInfo {
  name: string
  model: string
  sentText: string
}

/** SHA-256 over the settings, in a fixed order. Same values give the same fingerprint. */
export async function policyFingerprint(policy: Policy): Promise<string> {
  return sha256Hex(JSON.stringify(POLICY_KEYS.map((key) => [key, policy[key]])))
}

/** The Remote Config values in force right now, as a receipt records them. */
export async function currentConfig(): Promise<LocalReceipt['config']> {
  const { policy, status } = getPolicySnapshot()
  return {
    fingerprint: await policyFingerprint(policy),
    source: status.source,
    fetchedAt: status.fetchedAt ? new Date(status.fetchedAt).toISOString() : null,
  }
}

/** Newest first, by createdAt. */
export function newestFirst(receipts: LocalReceipt[]): LocalReceipt[] {
  return [...receipts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

function describeError(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error'
  const message = e instanceof Error ? e.message : String(e)
  return `${name}: ${message}`.slice(0, 200)
}

/**
 * Runs one model call with a receipt around it.
 *  1. Writes a 'pending' receipt: the exact text, its hash, the model, the config and the time.
 *     If that write fails, the call is NOT made and the send is refused (SendBlockedError).
 *  2. Runs the call.
 *  3. Writes the final record with the call's inferenceSource and status 'done'. If that write
 *     fails, the result is still returned and the receipt stays 'pending'.
 *  4. If the call throws, writes status 'failed' with the error, then rethrows it.
 * `run` must return the generateLogged() result: `{ text, source }`.
 */
export async function recordedCall<T extends { source: string }>(
  store: ReceiptStore,
  call: CallInfo,
  run: () => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> {
  const startedAt = now().toISOString()
  const pending: LocalReceipt = {
    id: crypto.randomUUID(),
    createdAt: startedAt,
    status: 'pending',
    sentText: call.sentText,
    sha256: await sha256Hex(call.sentText),
    model: call.model,
    config: await currentConfig(),
    steps: [{ name: call.name, startedAt, finishedAt: null, inferenceSource: null }],
    error: null,
  }
  try {
    await store.put(pending)
  } catch {
    throw new SendBlockedError(
      'Not sent: could not save the receipt on this device, so nothing was sent. ' +
        'Check that this browser allows site storage (IndexedDB), then try again.',
    )
  }

  let result: T
  try {
    result = await run()
  } catch (e) {
    const failedAt = now().toISOString()
    const failed: LocalReceipt = {
      ...pending,
      status: 'failed',
      error: describeError(e),
      steps: [{ ...pending.steps[0], finishedAt: failedAt }],
    }
    await store.put(failed).catch(() => undefined)
    throw e
  }

  const finishedAt = now().toISOString()
  const done: LocalReceipt = {
    ...pending,
    status: 'done',
    steps: [{ name: call.name, startedAt, finishedAt, inferenceSource: result.source || 'unknown' }],
  }
  await store.put(done).catch(() => console.warn('[receipt] could not finish a receipt; it stays pending'))
  return result
}
