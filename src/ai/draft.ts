// Drafting: the ONLY path that sends anything to the cloud.
//   1. Guard: user approved, redaction status "ok", and a fresh leak re-check passes.
//      Otherwise nothing is sent.
//   2. Cloud Gemini (ONLY_IN_CLOUD) drafts from the redacted text with a template.
//      A manager email sends ONLY the approved work restrictions (never the case notes).
//   3. Placeholders this template must not restore (e.g. MEDICAL_DETAIL in a manager email) are
//      withheld; everything else is restored on this device. The map never leaves the browser.
//   4. A receipt records the exact text sent, its SHA-256, the model and where each step ran.
//      A local receipt (receiptLog.ts) is written to IndexedDB BEFORE the cloud call; if it can't
//      be saved, nothing is sent.

import { cloudModel, ensureSignedIn, getDraftingModel } from '../firebase'
import { whenPolicyReady } from '../policy.ts'
import { SendBlockedError } from './errors.ts'
import { sendBlockReason } from './guard.ts'
import { generateLogged } from './inference.ts'
import { restore } from './placeholders.ts'
import { buildReceipt, type CloudReceipt, type ReceiptStep } from './receipt.ts'
import { currentConfig, recordedCall, type ReceiptStore } from './receiptLog.ts'
import { indexedReceiptStore } from './receiptStore.ts'
import type { RedactionResult } from './redact.ts'
import { accommodationBlockReason, type AccommodationPlan } from './restrictionPrompt.ts'
import { buildDraftPrompt, buildManagerPrompt, checkDraft, TEMPLATES, type TemplateId } from './templates.ts'

export { SendBlockedError }

export interface DraftResult {
  /** What the cloud wrote, with placeholders (safe to store in Firestore). */
  draftWithPlaceholders: string
  /** Final draft with real values restored on this device (never stored or sent). */
  restoredDraft: string
  warnings: string[]
  receipt: CloudReceipt
}

export async function draft(
  redaction: RedactionResult,
  templateId: TemplateId,
  options: { approved: boolean; accommodation?: AccommodationPlan; store?: ReceiptStore },
): Promise<DraftResult> {
  await whenPolicyReady() // the first Remote Config fetch (a few seconds at most, usually already done)

  // 1. Guard. "Approve & send" is the only way past this point.
  const blocked = sendBlockReason(redaction, options.approved)
  if (blocked) throw new SendBlockedError(blocked)

  // A manager email is built from the approved restrictions alone, checked again right here.
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

  // 2. Cloud draft from redacted text (or restrictions) only. The local receipt is saved first.
  await ensureSignedIn()
  const model = cloudModel() // read once: the call and the receipts must name the same model
  const { text: cloudText, source } = await recordedCall(
    options.store ?? indexedReceiptStore,
    { name: 'draft', model, sentText: prompt },
    () => generateLogged('draft', getDraftingModel(model), prompt),
  )

  // 3. Check and restore on this device.
  const checked = checkDraft(cloudText, redaction.map, templateId)
  const restoredDraft = restore(checked.text, redaction.map, TEMPLATES[templateId].withhold)

  // 4. Receipt.
  const steps: ReceiptStep[] = [
    { step: 'redaction', ranOn: redaction.ranOn, detail: `engine: ${redaction.engine}` },
  ]
  steps.push({
    step: 'names',
    ranOn: redaction.names === 'model' ? redaction.ranOn : 'on_device',
    detail: redaction.names === 'model' ? 'checked by a name model' : 'checked by the user',
  })
  if (redaction.crossCheck?.ran) {
    steps.push({ step: 'cross-check', ranOn: 'in_browser', detail: `hid ${redaction.crossCheck.added} more` })
  }
  if (template.input === 'restrictions') {
    steps.push({
      step: 'restrictions',
      ranOn: 'on_device',
      detail: `${options.accommodation?.restrictions.length ?? 0} approved; no diagnosis or case notes sent`,
    })
  }
  steps.push(
    { step: 'drafting', ranOn: source === 'unknown' ? 'in_cloud' : source, detail: template.label },
    { step: 'restore', ranOn: 'on_device' },
  )
  const config = await currentConfig()
  const receipt = await buildReceipt(prompt, model, steps, new Date(), config.fingerprint)

  return { draftWithPlaceholders: cloudText, restoredDraft, warnings: checked.warnings, receipt }
}
