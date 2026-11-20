// Drafting: the ONLY path that sends anything to the cloud.
//   1. Guard: user approved, redaction status "ok", and a fresh leak re-check passes.
//      Otherwise nothing is sent.
//   2. Cloud Gemini (ONLY_IN_CLOUD) drafts from the redacted text with a template.
//   3. Placeholders this template must not restore (e.g. MEDICAL in a manager email) are
//      withheld; everything else is restored on this device. The map never leaves the browser.
//   4. A receipt records the exact text sent, its SHA-256, the model and where each step ran.

import { CLOUD_MODEL, ensureSignedIn, getDraftingModel } from '../firebase'
import { findLeaks } from '../rules/rules.ts'
import { generateLogged } from './inference.ts'
import { restore, sensitiveStrings } from './placeholders.ts'
import { buildReceipt, type CloudReceipt, type ReceiptStep } from './receipt.ts'
import type { RedactionResult } from './redact.ts'
import { buildDraftPrompt, checkDraft, TEMPLATES, type TemplateId } from './templates.ts'

export interface DraftResult {
  /** What the cloud wrote, with placeholders (safe to store in Firestore). */
  draftWithPlaceholders: string
  /** Final draft with real values restored on this device (never stored or sent). */
  restoredDraft: string
  warnings: string[]
  receipt: CloudReceipt
}

/** Thrown when the guard refuses to send. The UI can show it as "blocked", not as a failure. */
export class SendBlockedError extends Error {
  override name = 'SendBlockedError'
}

export async function draft(
  redaction: RedactionResult,
  templateId: TemplateId,
  options: { approved: boolean },
): Promise<DraftResult> {
  // 1. Guard. "Approve & send" is the only way past this point.
  if (!options.approved) throw new SendBlockedError('Not sent: the user has not approved the redacted text.')
  if (redaction.status !== 'ok') throw new SendBlockedError('Not sent: redaction is blocked (something still leaks).')
  const leaks = findLeaks(redaction.redactedText, sensitiveStrings(redaction.map))
  if (leaks.length) {
    throw new SendBlockedError(`Not sent: the leak re-check found ${leaks.length} item(s) still visible.`)
  }

  // 2. Cloud draft from redacted text only.
  await ensureSignedIn()
  const prompt = buildDraftPrompt(redaction.redactedText, templateId)
  const { text: cloudText, source } = await generateLogged('draft', getDraftingModel(), prompt)

  // 3. Check and restore on this device.
  const checked = checkDraft(cloudText, redaction.map, templateId)
  const restoredDraft = restore(checked.text, redaction.map, TEMPLATES[templateId].withhold)

  // 4. Receipt.
  const steps: ReceiptStep[] = [
    { step: 'redaction', ranOn: redaction.ranOn, detail: `engine: ${redaction.engine}` },
  ]
  if (redaction.crossCheck?.ran) {
    steps.push({ step: 'cross-check', ranOn: 'in_browser', detail: `hid ${redaction.crossCheck.added} more` })
  }
  steps.push(
    { step: 'drafting', ranOn: source === 'unknown' ? 'in_cloud' : source, detail: TEMPLATES[templateId].label },
    { step: 'restore', ranOn: 'on_device' },
  )
  const receipt = await buildReceipt(prompt, CLOUD_MODEL, steps)

  return { draftWithPlaceholders: cloudText, restoredDraft, warnings: checked.warnings, receipt }
}
