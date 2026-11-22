// On-device step: rewrites medical details into functional work restrictions (no diagnosis).
// ONLY_ON_DEVICE: Gemini Nano reads the notes (health details put back, names still hidden) and
// nothing is sent anywhere. The original details stay in the redaction map as [MEDICAL_DETAIL_n].
// The result is a suggestion: the HR user edits and approves it before any manager email.

import type { GenerativeModel } from 'firebase/ai'
import { getRedactionModel } from '../firebase'
import { generateLogged } from './inference.ts'
import { nanoSupported, type RedactionResult } from './redact.ts'
import {
  buildRestrictionPrompt,
  cleanRestrictions,
  healthContext,
  parseRestrictions,
  RESTRICTION_SCHEMA,
  type Restriction,
} from './restrictionPrompt.ts'

export interface RestrictionResult {
  /** Safe suggestions. */
  items: Restriction[]
  /** Suggestions the checks rejected (health wording, names...). Their text is not kept. */
  dropped: number
  /** "unavailable": no Gemini Nano, so the user types the restrictions. */
  source: 'model' | 'unavailable'
  note?: string
}

let model: GenerativeModel | undefined
function restrictionModel(): GenerativeModel {
  model ??= getRedactionModel({ promptOptions: { responseConstraint: RESTRICTION_SCHEMA } })
  return model
}

/** Suggests work restrictions for `redaction`. Call from a button click (Chrome may download Nano). */
export async function deriveRestrictions(
  redaction: RedactionResult,
  onProgress?: (fraction: number) => void,
): Promise<RestrictionResult> {
  if (!(await nanoSupported())) {
    return {
      items: [],
      dropped: 0,
      source: 'unavailable',
      note: 'Gemini Nano is not available in this browser, so type the work restrictions yourself.',
    }
  }
  try {
    const nano = restrictionModel()
    await nano.initializeDeviceModel(onProgress)
    const prompt = buildRestrictionPrompt(healthContext(redaction.redactedText, redaction.map))
    const { text } = await generateLogged('restrictions', nano, prompt)
    const { kept, dropped } = cleanRestrictions(parseRestrictions(text), redaction.map, redaction.redactedText)
    return { items: kept, dropped, source: 'model' }
  } catch (e) {
    return {
      items: [],
      dropped: 0,
      source: 'unavailable',
      note: `Gemini Nano failed (${e instanceof Error ? e.message : String(e)}), so type the work restrictions yourself.`,
    }
  }
}
