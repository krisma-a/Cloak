// The ONLY file you change to connect the real AI.
// The screens import everything AI-related from here, and nothing else.
//
// Right now they use the placeholder versions from fakeAi.ts (nothing is sent anywhere).

export { redactNotes, suggestRestrictions, writeDraft, SendBlockedError } from './fakeAi.ts'

/** Shows a "Demo mode" tag at the top. Set to false when the real AI is connected. */
export const DEMO_MODE = true

// ---------------------------------------------------------------------------------------------
// TO CONNECT THE REAL AI (ask Pam to check this first):
//
// 1. Delete the `export { ... } from './fakeAi.ts'` line above.
// 2. Paste this in its place:
//
//    import { prepareRedaction, redact } from '../ai/redact'
//    import type { RedactionResult } from '../ai/redact'
//
//    export async function redactNotes(
//      notes: string,
//      onProgress?: (fraction: number) => void,
//    ): Promise<RedactionResult> {
//      const { engine } = await prepareRedaction(onProgress)
//      return redact(notes, { engine })
//    }
//    export { deriveRestrictions as suggestRestrictions } from '../ai/restrict'
//    export { draft as writeDraft, SendBlockedError } from '../ai/draft'
//
// 3. Set DEMO_MODE to false.
//
// redactNotes() must run from a button click: Chrome only starts the Gemini Nano download
// after a click. The screens already call it from the "Hide private details" button.
// ---------------------------------------------------------------------------------------------
