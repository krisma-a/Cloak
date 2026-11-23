// The ONLY file you change to connect the real AI.
// The screens import everything AI-related from here, and nothing else.
//
// Redaction is REAL: it runs the on-device engine from src/ai/redact.ts, on this laptop only.
// Restrictions and drafting are still the placeholders from fakeAi.ts, so nothing is sent anywhere.

import type { AiStage } from './aiStatus.ts'
import type { RedactionResult } from './types.ts'

/** What the screen can find out and do while the notes are being hidden. All optional. */
export interface RedactHooks {
  /** Which model is about to load, before any download starts ("nano" or "simpler"). */
  onStage?: (stage: AiStage) => void
  /** The engine that is ready (after any download), just before the notes are checked. */
  onEngine?: (engine: RedactionResult['engine']) => void
  /**
   * Abort this to stop waiting for the Gemini Nano download: the notes are checked with the simpler engine
   * right away, and the Nano download keeps going in the background.
   */
  skipDownload?: AbortSignal
  /** The download that was skipped has ended. `engine` is "nano" if the private AI is now ready for the next check. */
  onBackgroundDone?: (engine: RedactionResult['engine']) => void
}

export { suggestRestrictions, writeDraft, SendBlockedError } from './fakeAi.ts'

/**
 * True while drafting is still the placeholder (nothing is sent anywhere). The header pill's tooltip says so.
 * Set to false when the real drafting is connected (see below).
 */
export const DEMO_MODE = true

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
 * False means notes get the simpler checks.
 */
export async function privateAiSupported(): Promise<boolean> {
  return (await loadRedact()).nanoSupported()
}

// True while a Nano download that the person chose not to wait for is still running. Another wait on it
// would show no progress (Chrome reports progress to the first caller only), so later checks use the
// simpler engine until it finishes.
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

  // An earlier download is still running in the background: use the simpler engine without waiting on it.
  if (nanoInBackground) {
    hooks.onStage?.('simpler')
    const { engine } = await prepareRedaction(onProgress, 'browser-model')
    hooks.onEngine?.(engine)
    return redact(notes, { engine })
  }

  hooks.onStage?.((await nanoSupported()) ? 'nano' : 'simpler')
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

// ---------------------------------------------------------------------------------------------
// TO CONNECT THE REAL DRAFTING (ask Pam to check this first):
//
// 1. Delete the `export { ... } from './fakeAi.ts'` line above.
// 2. Paste this in its place:
//
//    export { deriveRestrictions as suggestRestrictions } from '../ai/restrict'
//    export { draft as writeDraft, SendBlockedError } from '../ai/draft'
//
// 3. Set DEMO_MODE to false.
// ---------------------------------------------------------------------------------------------
