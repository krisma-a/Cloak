// The three pipelines the /eval page compares, built from the app's own code. Not pure: it imports Firebase
// code, so it cannot run under `node --test`. Everything it measures is scored in score.ts and runner.ts.
//
//   regex    rules only (redact(..., 'rules-only')): fixed-shape details and medical keywords; no model
//   nano     ONE Gemini Nano pass: no name cross-check, no retries, no leak check, no blocking
//   full     what the app does: Nano (or the backup engine), name cross-check, retries, then the send guard
//
// FAKE DATA ONLY. If cloud timing is on, the full pipeline sends the HIDDEN text of the first few notes that
// pass the guard through draft(), the same path the app uses. Those sends use an in-memory receipt store and
// no send log, so they never appear in anyone's real receipts or logs.

import { draft } from '../ai/draft.ts'
import { sendBlockReason } from '../ai/guard.ts'
import { currentConfig, type LocalReceipt, type ReceiptStore } from '../ai/receiptLog.ts'
import { prepareRedaction, redact, redactNanoPass, type RedactionResult } from '../ai/redact.ts'
import type { AccommodationPlan } from '../ai/restrictionPrompt.ts'
import { setUsageOrigin } from '../ai/usage.ts'
import { ensureSignedIn } from '../firebase'
import { getPolicy, whenPolicyReady } from '../policy.ts'
import type { Pipeline } from './runner.ts'
import type { EvalCase, PipelineOutput } from './score.ts'

/** Stands in for the browser's receipt database, so eval sends leave nothing behind. */
class MemoryReceiptStore implements ReceiptStore {
  private rows = new Map<string, LocalReceipt>()
  async put(receipt: LocalReceipt): Promise<void> {
    this.rows.set(receipt.id, receipt)
  }
  async list(): Promise<LocalReceipt[]> {
    return [...this.rows.values()]
  }
}

const now = (): number => performance.now()

/** A manager email needs an approved plan. The eval uses the first name and one made-up, harmless restriction. */
function accommodationPlan(result: RedactionResult): AccommodationPlan | null {
  const employee = Object.keys(result.map.originals).find((placeholder) => placeholder.startsWith('[EMPLOYEE_'))
  return employee ? { employee, restrictions: ['a short break every 2 hours'] } : null
}

export interface BuiltPipelines {
  pipelines: Pipeline[]
  /** What the run used. Settings and engine names only, never text. */
  context: Record<string, unknown>
}

/**
 * Loads the on-device models and returns the pipelines. Call it from a button click: Chrome only starts the
 * Gemini Nano download after a click.
 * `cloudSample`: how many notes (that pass the guard) also get a cloud draft, to time it. 0 = none.
 */
export async function buildPipelines(options: {
  cloudSample: number
  onProgress?: (fraction: number) => void
}): Promise<BuiltPipelines> {
  setUsageOrigin('eval') // usage records from this page are marked "eval", apart from real use
  await whenPolicyReady() // so the first note is not charged for waiting on Remote Config
  const prepared = await prepareRedaction(options.onProgress, 'auto')
  const nanoReady = prepared.engine === 'nano'
  if (options.cloudSample > 0) await ensureSignedIn() // so the first cloud timing does not include signing in

  let cloudLeft = Math.max(0, Math.floor(options.cloudSample))
  const receipts = new MemoryReceiptStore()

  const regex: Pipeline = {
    id: 'regex',
    label: 'Regex only',
    hasBlocking: false,
    async run(note: EvalCase): Promise<PipelineOutput> {
      const start = now()
      const result = await redact(note.text, { engine: 'rules-only' })
      return { text: result.redactedText, blocked: false, onDeviceMs: now() - start, engine: result.engine, attempts: result.attempts }
    },
  }

  const nano: Pipeline = {
    id: 'nano',
    label: 'On-device model only',
    hasBlocking: false,
    skipped: nanoReady ? undefined : (prepared.note ?? 'Gemini Nano is not available in this browser'),
    async run(note: EvalCase): Promise<PipelineOutput> {
      const start = now()
      const result = await redactNanoPass(note.text)
      return { text: result.redactedText, blocked: false, onDeviceMs: now() - start, engine: result.engine, attempts: result.attempts }
    },
  }

  const full: Pipeline = {
    id: 'full',
    label: 'Full Cloak',
    hasBlocking: true,
    async run(note: EvalCase): Promise<PipelineOutput> {
      const start = now()
      const result = await redact(note.text, { engine: prepared.engine }) // retries come from the max_retries setting
      const onDeviceMs = now() - start
      const output: PipelineOutput = {
        text: result.redactedText,
        // The same guard the app uses before any send. It refuses a leak, a medical note in "block" mode, and so on.
        blocked: sendBlockReason(result, true) !== null,
        onDeviceMs,
        engine: result.engine,
        attempts: result.attempts,
      }

      if (!output.blocked && cloudLeft > 0) {
        const plan = note.scenario === 'accommodation' ? accommodationPlan(result) : undefined
        if (plan !== null) {
          cloudLeft--
          const cloudStart = now()
          try {
            await draft(result, note.scenario, { approved: true, accommodation: plan, store: receipts, logSend: null })
            output.cloudMs = now() - cloudStart
          } catch {
            output.cloudFailed = true
          }
        }
      }
      return output
    },
  }

  const config = await currentConfig()
  return {
    pipelines: [regex, nano, full],
    context: {
      fullPipelineEngine: prepared.engine,
      nanoAvailable: nanoReady,
      engineNote: prepared.note ?? null,
      settings: getPolicy(),
      settingsVersion: config.fingerprint,
      cloudSample: options.cloudSample,
    },
  }
}
