// The ONLY file you change to connect the real AI.
// The screens import everything AI-related from here, and nothing else.
//
// Redaction is REAL: it runs the on-device engine from src/ai/redact.ts, on this laptop only.
// Drafting is Demo or Real AI (see below).

import type { AiStage } from './aiStatus.ts'

/** What the screen can find out and do while the notes are being hidden. All optional. */
export interface RedactHooks {
  /** Which model is about to load, before any download starts ("nano" or "basic"). */
  onStage?: (stage: AiStage) => void
  /** The engine that is ready (after any download), just before the notes are checked. */
  onEngine?: (engine: RedactionResult['engine']) => void
  /**
   * Abort this to stop waiting for the Gemini Nano download: the notes are checked with the basic engine
   * right away, and the Nano download keeps going in the background.
   */
  skipDownload?: AbortSignal
  /** The download that was skipped has ended. `engine` is "nano" if the private AI is now ready for the next check. */
  onBackgroundDone?: (engine: RedactionResult['engine']) => void
  /**
   * The person chose "Basic checks only" (for a slow laptop): use the backup engine and never start or wait for
   * Gemini Nano. Catches less, so the review screen asks for a careful read (needsCarefulReview).
   */
  basicOnly?: boolean
}

// Drafting has two modes, switched at run time so the team can test the real AI without a new build:
//   Demo (the default): the placeholder draft from fakeAi.ts. Nothing is sent anywhere.
//   Real AI: src/ai/draft.ts. After the guard and the person's approval, the placeholder text (never the real details,
//   never a photo) goes to Gemini in the cloud. It uses the free-tier quota the team shares, so it can answer 429.
// The choice is kept in this browser (localStorage cloak.realAi). A link ending ?ai=real or ?ai=demo sets it too.
// To make Real AI the default for everyone, change DEFAULT_REAL_AI below to true.

import { SendBlockedError } from '../ai/errors.ts'
import * as demo from './fakeAi.ts'
import type { AccommodationPlan, DraftResult, RedactionResult, TemplateId } from './types.ts'

export { SendBlockedError }

const DEFAULT_REAL_AI = false
const REAL_AI_KEY = 'cloak.realAi'

/** Whether drafting goes to the real cloud model (true) or the placeholder (false) in this browser. */
export function realAiEnabled(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    const saved = storage?.getItem(REAL_AI_KEY)
    return saved === 'on' ? true : saved === 'off' ? false : DEFAULT_REAL_AI
  } catch {
    return DEFAULT_REAL_AI
  }
}

export function setRealAi(on: boolean, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(REAL_AI_KEY, on ? 'on' : 'off')
  } catch {
    // Not remembered: the choice applies until the page reloads.
  }
}

/** Reads ?ai=real or ?ai=demo from the address and saves it, so a teammate can send a link that sets the mode. */
export function applyAiParam(search: string = globalThis.location?.search ?? ''): void {
  const value = new URLSearchParams(search).get('ai')
  if (value === 'real') setRealAi(true)
  else if (value === 'demo') setRealAi(false)
}

/** Work restrictions for the manager email. Real: Gemini Nano on this laptop (needs Chrome with the private AI). */
export async function suggestRestrictions(redaction: RedactionResult) {
  if (!realAiEnabled()) return demo.suggestRestrictions(redaction)
  return (await import('../ai/restrict.ts')).deriveRestrictions(redaction)
}

/** Writes the draft. Real mode sends the placeholder text to the cloud model; Demo sends nothing. */
export async function writeDraft(
  redaction: RedactionResult,
  templateId: TemplateId,
  options: { approved: boolean; accommodation?: AccommodationPlan },
): Promise<DraftResult> {
  if (!realAiEnabled()) return demo.writeDraft(redaction, templateId, options)
  return (await import('../ai/draft.ts')).draft(redaction, templateId, options)
}

// The redaction code pulls in Firebase, so it loads in the background as soon as the app starts instead of
// being part of the first screen. By the time someone clicks "Hide private details" it is already here, which
// matters: Chrome only starts the Gemini Nano download within a few seconds of a click.
let redactModule: Promise<typeof import('../ai/redact.ts')> | undefined

function loadRedact(): Promise<typeof import('../ai/redact.ts')> {
  redactModule ??= import('../ai/redact.ts')
  return redactModule
}

void loadRedact().catch(() => {
  redactModule = undefined // try again on the click, which then reports the error
})

/**
 * Whether this browser can run Gemini Nano (the private AI). Downloads nothing and needs no click.
 * False means notes get the basic checks.
 */
export async function privateAiSupported(): Promise<boolean> {
  return (await loadRedact()).nanoSupported()
}

// True while a Nano download that the person chose not to wait for is still running. Another wait on it
// would show no progress (Chrome reports progress to the first caller only), so later checks use the
// basic engine until it finishes.
let nanoInBackground = false

/** Resolves when `signal` is aborted. Never resolves if there is no signal. */
function aborted(signal: AbortSignal | undefined): Promise<'skipped'> {
  return new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) resolve('skipped')
    else signal.addEventListener('abort', () => resolve('skipped'), { once: true })
  })
}

/**
 * Hides the private details in `notes` on this laptop. MUST be called from a button click: Chrome only starts
 * the Gemini Nano download after one. The first time, the model downloads here, and `onProgress` gets
 * 0..1 only while something is really downloading. The person can stop waiting (see `hooks.skipDownload`).
 */
export async function redactNotes(
  notes: string,
  onProgress?: (fraction: number) => void,
  hooks: RedactHooks = {},
): Promise<RedactionResult> {
  const { nanoSupported, prepareRedaction, redact } = await loadRedact()

  // The person chose basic checks, or an earlier download is still running in the background: use the basic
  // engine without starting or waiting on Nano.
  if (hooks.basicOnly || nanoInBackground) {
    hooks.onStage?.('basic')
    const { engine } = await prepareRedaction(onProgress, 'browser-model')
    hooks.onEngine?.(engine)
    return redact(notes, { engine })
  }

  hooks.onStage?.((await nanoSupported()) ? 'nano' : 'basic')
  let forwardNanoProgress = true
  const preparing = prepareRedaction((fraction) => {
    if (forwardNanoProgress) onProgress?.(fraction)
  })
  const first = await Promise.race([preparing, aborted(hooks.skipDownload)])

  if (first === 'skipped') {
    // Stop watching the Nano download, but do not cancel it: Chrome keeps downloading, and we are told when it ends.
    forwardNanoProgress = false
    nanoInBackground = true
    const finished = (engine: RedactionResult['engine']) => {
      nanoInBackground = false
      hooks.onBackgroundDone?.(engine)
    }
    void preparing.then(
      ({ engine }) => finished(engine),
      () => finished('browser-model'),
    )
    const { engine } = await prepareRedaction(onProgress, 'browser-model')
    hooks.onEngine?.(engine)
    return redact(notes, { engine })
  }

  hooks.onEngine?.(first.engine)
  return redact(notes, { engine: first.engine })
}
