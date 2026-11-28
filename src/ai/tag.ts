// Small tasks on redacted text: tag the case type and rewrite tone.
// Uses the PREFER_ON_DEVICE model: Nano when available, cloud otherwise. Because it can fall
// back to the cloud, the same leak guard as drafting runs first.

import { cloudModel, getTaggingModel } from '../firebase'
import { CASE_TYPES, parseCaseType, type CaseType } from './caseType.ts'
import { getPolicy } from '../policy.ts'
import { assertCloudDraftsEnabled } from './cloudPause.ts'
import { SendBlockedError } from './errors.ts'
import { redactionBlockReason } from './guard.ts'
import { generateLogged } from './inference.ts'
import { findPlaceholders } from './placeholders.ts'
import { recordedCall, type ReceiptStore } from './receiptLog.ts'
import { indexedReceiptStore } from './receiptStore.ts'
import type { RedactionResult } from './redact.ts'

export const TONES = ['neutral', 'warmer', 'firmer'] as const
export type Tone = (typeof TONES)[number]

function assertSafe(redaction: RedactionResult) {
  assertCloudDraftsEnabled(getPolicy()) // these can fall back to the cloud, so the kill switch covers them too
  const blocked = redactionBlockReason(redaction)
  if (blocked) throw new SendBlockedError(blocked)
}

// These run on the device when Nano can, and may fall back to the cloud. Either way a local receipt
// is saved first, and its inferenceSource says where the call actually ran.

export async function tagCaseType(
  redaction: RedactionResult,
  store: ReceiptStore = indexedReceiptStore,
): Promise<CaseType | null> {
  assertSafe(redaction)
  const redactedText = redaction.redactedText
  const prompt = `Classify this redacted HR case note as exactly one of: ${CASE_TYPES.join(', ')}.
Placeholders like [EMPLOYEE_1] stand for hidden details. Reply with the single word only.

<<<
${redactedText}
>>>`
  const { text } = await recordedCall(store, { name: 'tag-case-type', model: cloudModel(), sentText: prompt }, () =>
    generateLogged('tag-case-type', getTaggingModel(), prompt),
  )
  return parseCaseType(text)
}

/** Rewrites tone. If the model drops, adds or changes a placeholder, returns the original text. */
export async function rewriteTone(
  redaction: RedactionResult,
  tone: Tone,
  store: ReceiptStore = indexedReceiptStore,
): Promise<{ text: string; changed: boolean }> {
  assertSafe(redaction)
  const { redactedText, map } = redaction
  const prompt = `Rewrite the text below in a ${tone} professional tone.
Keep every placeholder like [EMPLOYEE_1] exactly as written. Do not add facts or new placeholders.
Reply with the rewritten text only.

<<<
${redactedText}
>>>`
  const { text } = await recordedCall(store, { name: 'rewrite-tone', model: cloudModel(), sentText: prompt }, () =>
    generateLogged('rewrite-tone', getTaggingModel(), prompt),
  )
  const ids = (s: string) => findPlaceholders(s, map).map((p) => p.placeholder).sort().join(',')
  return ids(text) === ids(redactedText) && text ? { text, changed: true } : { text: redactedText, changed: false }
}
