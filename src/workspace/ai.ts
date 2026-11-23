// The ONLY file you change to connect the real AI.
// The screens import everything AI-related from here, and nothing else.
//
// Redaction is REAL: it runs the on-device engine from src/ai/redact.ts, on this laptop only.
// Restrictions and drafting are still the placeholders from fakeAi.ts, so nothing is sent anywhere.

import type { AiStage } from './aiStatus.ts'
import type { RedactionResult } from './types.ts'

/** What the screen can find out while the notes are being hidden. All optional. */
export interface RedactHooks {
  /** Which model is about to load, before any download starts ("nano" or "simpler"). */
  onStage?: (stage: AiStage) => void
  /** The engine that is ready (after any download), just before the notes are checked. */
  onEngine?: (engine: RedactionResult['engine']) => void
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

/**
 * Hides the private details in `notes` on this laptop. MUST be called from a button click: Chrome only starts
 * the Gemini Nano download after one. The first time, the model downloads here, and `onProgress` gets
 * 0..1 only while something is really downloading.
 */
export async function redactNotes(
  notes: string,
  onProgress?: (fraction: number) => void,
  hooks: RedactHooks = {},
): Promise<RedactionResult> {
  const { nanoSupported, prepareRedaction, redact } = await loadRedact()
  hooks.onStage?.((await nanoSupported()) ? 'nano' : 'simpler')
  const { engine } = await prepareRedaction(onProgress)
  hooks.onEngine?.(engine)
  return redact(notes, { engine })
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
