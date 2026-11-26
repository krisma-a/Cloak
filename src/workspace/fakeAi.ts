// PLACEHOLDER AI. Nothing here is a real model and nothing is sent anywhere.
//
// Only the two AI steps are fake: "find the private details" and "write the draft".
// Everything around them is your real code (placeholders, leak check, guard, templates, receipt),
// so the screens behave the way the finished app will. The functions have the same inputs and
// outputs as the real ones; ai.ts is the one file that decides which version the screens use.

import { sendBlockReason } from '../ai/guard.ts'
import { whenPolicyReady } from '../policy.ts'
import { applyEntities, countByPrefix, restore, sensitiveStrings } from '../ai/placeholders.ts'
import type { Entity } from '../ai/placeholders.ts'
import { buildReceipt } from '../ai/receipt.ts'
import type { ReceiptStep } from '../ai/receipt.ts'
import { accommodationBlockReason } from '../ai/restrictionPrompt.ts'
import type { Restriction } from '../ai/restrictionPrompt.ts'
import { medicalTerms, ruleEntities } from '../ai/ruleEntities.ts'
import { buildDraftPrompt, buildManagerPrompt, checkDraft, TEMPLATES } from '../ai/templates.ts'
import { findLeaks } from '../rules/rules.ts'
import { SendBlockedError } from '../ai/errors.ts'
import { buildUsageEvent } from '../ai/usage.ts'
import type { AccommodationPlan, DraftResult, RedactionResult, TemplateId } from './types.ts'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// The same class the real draft() throws, so the screens recognise a refused send in either mode.
export { SendBlockedError }

// A stand-in for the name finder: two or three capitalised words in a row ("Maria Santos").
// The real engines (Gemini Nano, the in-browser name model) do this much better.
const CAPITAL_RUN = /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}+(?:[ \t]+\p{Lu}\p{Ll}+){1,2}(?![\p{L}\p{N}])/gu
const NOT_NAMES = new Set([
  'Human', 'Resources', 'Next', 'Steps', 'Case', 'Review', 'Open', 'Questions', 'Background',
  'Summary', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
])

function demoNames(text: string): Entity[] {
  const found: Entity[] = []
  for (const match of text.matchAll(CAPITAL_RUN)) {
    if (match[0].split(/\s+/).some((word) => NOT_NAMES.has(word))) continue
    found.push({ text: match[0], category: 'PERSON' })
  }
  return found
}

/**
 * Same inputs and output as the real redaction:
 *   prepareRedaction(onProgress) then redact(notes, { engine })   (src/ai/redact.ts)
 * `onProgress` gets 0..1 while the on-laptop model loads (the first time it can download).
 */
export async function redactNotes(
  notes: string,
  onProgress?: (fraction: number) => void,
): Promise<RedactionResult> {
  await whenPolicyReady() // the first Remote Config fetch, so a live setting applies from the first click
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await wait(220)
    onProgress?.(fraction)
  }

  const entities = [...ruleEntities(notes), ...medicalTerms(notes), ...demoNames(notes)]
  const { text: redactedText, map } = applyEntities(notes, entities)
  const leaks = findLeaks(redactedText, sensitiveStrings(map))
  return {
    status: leaks.length ? 'blocked' : 'ok',
    engine: 'nano',
    needsCarefulReview: false,
    names: 'model',
    redactedText,
    map,
    leaks,
    attempts: 1,
    ranOn: 'on_device',
    counts: countByPrefix(map),
    note: 'Demo mode: these details were found by placeholder code, not the real AI.',
  }
}

/**
 * Same inputs and output as the real deriveRestrictions() (src/ai/restrict.ts).
 * Only used for the accommodation email, which sends work restrictions and never the notes.
 */
export async function suggestRestrictions(
  redaction: RedactionResult,
): Promise<{ items: Restriction[]; dropped: number; source: 'model' | 'unavailable'; note?: string }> {
  await wait(700)
  const items: Restriction[] = []
  for (const match of redaction.redactedText.matchAll(/\bneeds?\s+([^.;\n]{4,80})/gi)) {
    const text = match[1]?.trim()
    if (text && !text.includes('[')) items.push({ kind: 'OTHER', text })
  }
  return { items, dropped: 0, source: 'model', note: 'Demo mode: placeholder suggestions.' }
}

function fakeCloudDraft(templateId: TemplateId, redaction: RedactionResult, plan?: AccommodationPlan): string {
  if (TEMPLATES[templateId].input === 'restrictions' && plan) {
    const list = plan.restrictions
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r, i) => `${i + 1}. ${r}`)
      .join('\n')
    return [
      'Subject: Workplace adjustments',
      '',
      'Hello,',
      '',
      `Please make the following adjustments for ${plan.employee}:`,
      list,
      '',
      'Please keep this confidential and send any questions to HR.',
      '',
      'Thank you,',
      'HR',
    ].join('\n')
  }
  return [
    `${TEMPLATES[templateId].label} (demo draft)`,
    '',
    'Summary of the notes provided',
    redaction.redactedText,
    '',
    'Recommended next steps',
    '1. Confirm the timeline with everyone involved.',
    '2. Record what was agreed and by when.',
    '3. Schedule a follow-up check-in.',
  ].join('\n')
}

/**
 * Same inputs and output as the real draft() (src/ai/draft.ts). The guard, the template prompt,
 * the draft check, the restore and the receipt are all real; only the cloud call is faked.
 */
export async function writeDraft(
  redaction: RedactionResult,
  templateId: TemplateId,
  options: { approved: boolean; accommodation?: AccommodationPlan },
): Promise<DraftResult> {
  await whenPolicyReady()
  const blocked = sendBlockReason(redaction, options.approved)
  if (blocked) throw new SendBlockedError(blocked)

  const template = TEMPLATES[templateId]
  let prompt: string
  if (template.input === 'restrictions') {
    const plan = options.accommodation
    const problem = accommodationBlockReason(plan, redaction.map, redaction.redactedText)
    if (problem || !plan) throw new SendBlockedError(problem ?? 'Not sent: no work restrictions.')
    prompt = buildManagerPrompt(plan.employee, plan.restrictions)
  } else {
    prompt = buildDraftPrompt(redaction.redactedText, templateId)
  }

  await wait(1400) // the real version waits for the cloud model here
  const cloudText = fakeCloudDraft(templateId, redaction, options.accommodation)

  const checked = checkDraft(cloudText, redaction.map, templateId)
  const restoredDraft = restore(checked.text, redaction.map, template.withhold)

  const steps: ReceiptStep[] = [
    { step: 'redaction', ranOn: redaction.ranOn, detail: `engine: ${redaction.engine}` },
    { step: 'drafting', ranOn: 'in_cloud', detail: `${template.label} (demo, nothing was sent)` },
    { step: 'restore', ranOn: 'on_device' },
  ]
  const receipt = await buildReceipt(prompt, 'demo-placeholder', steps)
  // What a real draft of this size would have used (an estimate from the lengths; nothing was sent).
  const usage = buildUsageEvent({ label: 'draft', model: 'gemini-3.6-flash', source: 'in_cloud', usage: null, promptChars: prompt.length, outputChars: cloudText.length })
  return { draftWithPlaceholders: cloudText, restoredDraft, warnings: checked.warnings, receipt, usage: usage ?? undefined }
}
