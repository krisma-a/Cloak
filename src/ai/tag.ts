// Small tasks on redacted text: tag the case type and rewrite tone.
// Uses the PREFER_ON_DEVICE model: Nano when available, cloud otherwise. Because it can fall
// back to the cloud, the same leak guard as drafting runs first.

import { findLeaks } from '../rules/rules.ts'
import { SendBlockedError } from './draft.ts'
import { getTaggingModel } from '../firebase'
import { CASE_TYPES, parseCaseType, type CaseType } from './caseType.ts'
import { generateLogged } from './inference.ts'
import { findPlaceholders, sensitiveStrings, type PlaceholderMap } from './placeholders.ts'

export const TONES = ['neutral', 'warmer', 'firmer'] as const
export type Tone = (typeof TONES)[number]

function assertSafe(text: string, map: PlaceholderMap) {
  const leaks = findLeaks(text, sensitiveStrings(map))
  if (leaks.length) throw new SendBlockedError(`Not sent: the leak re-check found ${leaks.length} item(s) still visible.`)
}

export async function tagCaseType(redactedText: string, map: PlaceholderMap): Promise<CaseType | null> {
  assertSafe(redactedText, map)
  const prompt = `Classify this redacted HR case note as exactly one of: ${CASE_TYPES.join(', ')}.
Placeholders like [EMPLOYEE_1] stand for hidden details. Reply with the single word only.

<<<
${redactedText}
>>>`
  const { text } = await generateLogged('tag-case-type', getTaggingModel(), prompt)
  return parseCaseType(text)
}

/** Rewrites tone. If the model drops, adds or changes a placeholder, returns the original text. */
export async function rewriteTone(
  redactedText: string,
  tone: Tone,
  map: PlaceholderMap,
): Promise<{ text: string; changed: boolean }> {
  assertSafe(redactedText, map)
  const prompt = `Rewrite the text below in a ${tone} professional tone.
Keep every placeholder like [EMPLOYEE_1] exactly as written. Do not add facts or new placeholders.
Reply with the rewritten text only.

<<<
${redactedText}
>>>`
  const { text } = await generateLogged('rewrite-tone', getTaggingModel(), prompt)
  const ids = (s: string) => findPlaceholders(s, map).map((p) => p.placeholder).sort().join(',')
  return ids(text) === ids(redactedText) && text ? { text, changed: true } : { text: redactedText, changed: false }
}
