// Draft templates and the checks that run on a draft after the cloud returns it.
// The cloud only ever sees redacted text with placeholders. Pure functions (no Firebase).

import { findPlaceholders, type PlaceholderMap } from './placeholders.ts'

export type TemplateId = 'investigation' | 'accommodation' | 'termination'

export interface Template {
  id: TemplateId
  label: string
  /** Who reads the draft. Manager-facing drafts never get medical details back. */
  audience: 'hr-file' | 'manager' | 'employee'
  /** Placeholder prefixes that are never restored in this draft (become "[withheld]"). */
  withhold: string[]
  instructions: string
}

export const TEMPLATES: Record<TemplateId, Template> = {
  investigation: {
    id: 'investigation',
    label: 'Investigation summary (HR file)',
    audience: 'hr-file',
    withhold: [],
    instructions: `Write an investigation summary for the HR case file with these sections:
Background, Allegations, People involved, Evidence so far, Recommended next steps, Open questions.
Describe claims as allegations unless the notes say they were confirmed.
Do not reach legal conclusions.`,
  },
  accommodation: {
    id: 'accommodation',
    label: 'Accommodation email to manager',
    audience: 'manager',
    // 29 CFR 1630.14: managers may learn work restrictions, not diagnoses.
    withhold: ['MEDICAL', 'FAMILY_MEDICAL', 'DOB', 'SALARY', 'ID'],
    instructions: `Write a short email from HR to the employee's manager about a workplace accommodation.
Include ONLY the work restrictions or adjustments needed and practical next steps for the team.
NEVER mention or hint at any diagnosis, condition, symptom, medication or treatment,
including a family member's.
NEVER use any [MEDICAL_...], [FAMILY_MEDICAL_...], [DOB_...], [SALARY_...] or [ID_...] placeholder.
Remind the manager to keep this confidential.`,
  },
  termination: {
    id: 'termination',
    label: 'Termination letter (employee)',
    audience: 'employee',
    withhold: ['MEDICAL', 'FAMILY_MEDICAL'],
    instructions: `Write a respectful, factual termination letter to the employee.
State the reason only as supported by the notes, the effective date and next steps
(final pay, returning company property, benefits contact).
Never mention medical details.`,
  },
}

const COMMON_RULES = `You are an HR writing assistant. The case notes below are redacted:
placeholders like [EMPLOYEE_1], [ROLE_1] or [MEDICAL_1] stand for hidden details.
Rules:
- Keep every placeholder exactly as written, with its brackets and number.
- Never guess, invent or describe what is behind a placeholder.
- Never create new placeholders. Write "____" for anything the notes do not say.
- Neutral, professional tone. Plain text, no markdown.`

/** The full prompt sent to the cloud model. Contains only redacted text. */
export function buildDraftPrompt(redactedText: string, templateId: TemplateId): string {
  const template = TEMPLATES[templateId]
  return `${COMMON_RULES}\n\nTask:\n${template.instructions}\n\nRedacted case notes:\n<<<\n${redactedText}\n>>>`
}

export interface DraftCheck {
  /** Draft with withheld placeholders replaced, ready for restore(). */
  text: string
  warnings: string[]
}

/**
 * Checks a draft from the cloud before names are restored:
 * - placeholders this template must not restore are withheld (and reported),
 * - placeholders the model invented (not in the map) are reported.
 */
export function checkDraft(draft: string, map: PlaceholderMap, templateId: TemplateId): DraftCheck {
  const template = TEMPLATES[templateId]
  const warnings: string[] = []
  const withheld: Record<string, number> = {}
  const invented = new Set<string>()

  // Same matcher as restore(), so a reformatted "[ medical 1 ]" is withheld and counted too.
  for (const { placeholder, prefix, known } of findPlaceholders(draft, map)) {
    if (template.withhold.includes(prefix)) withheld[prefix] = (withheld[prefix] ?? 0) + 1
    else if (!known) invented.add(placeholder)
  }

  for (const [prefix, n] of Object.entries(withheld)) {
    warnings.push(`Withheld ${n} ${prefix} detail(s): not allowed in a ${template.audience} draft.`)
  }
  if (invented.size) {
    warnings.push(`The draft used placeholders that don't exist: ${[...invented].join(', ')}. Check those lines.`)
  }
  return { text: draft, warnings }
}
