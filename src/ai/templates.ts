// Draft templates and the checks that run on a draft after the cloud returns it.
// The cloud only ever sees redacted text with placeholders. Pure functions (no Firebase).

import { findPlaceholders, HEALTH_PREFIXES, type PlaceholderMap } from './placeholders.ts'
import { healthWording } from './restrictionPrompt.ts'

export type TemplateId = 'investigation' | 'accommodation' | 'termination'

export interface Template {
  id: TemplateId
  label: string
  /** Who reads the draft. Manager-facing drafts never get medical details back. */
  audience: 'hr-file' | 'manager' | 'employee'
  /** Placeholder prefixes that are never restored in this draft (become "[withheld]"). */
  withhold: string[]
  /** What the cloud gets: the redacted notes, or ONLY the approved work restrictions. */
  input: 'notes' | 'restrictions'
  instructions: string
}

export const TEMPLATES: Record<TemplateId, Template> = {
  investigation: {
    id: 'investigation',
    label: 'Investigation summary (HR file)',
    audience: 'hr-file',
    // 29 CFR 1630.14(c)(1): medical information lives in a separate confidential medical file,
    // not the general case file. Health details stay as "[withheld]" here; add them by hand to
    // the medical file if the case needs them.
    withhold: [...HEALTH_PREFIXES],
    input: 'notes',
    instructions: `Write an investigation summary for the HR case file with these sections:
Background, Allegations, People involved, Evidence so far, Recommended next steps, Open questions.
Describe claims as allegations unless the notes say they were confirmed.
Do not reach legal conclusions.
Health details belong in a separate confidential medical file. If one matters, refer to it only
by its placeholder and do not describe or guess it.`,
  },
  accommodation: {
    id: 'accommodation',
    label: 'Accommodation email to manager',
    audience: 'manager',
    // 29 CFR 1630.14(c)(1)(i): managers may learn necessary work restrictions and accommodations,
    // not diagnoses. The cloud gets ONLY the approved restrictions (see buildManagerPrompt), so
    // the withhold list is a second layer in case it still writes a health placeholder.
    withhold: [...HEALTH_PREFIXES, 'DOB', 'SALARY', 'ID'],
    input: 'restrictions',
    instructions: `Write a short email from HR to the employee's manager about workplace adjustments.
State each approved restriction clearly, then practical next steps for the team.
Ask the manager to keep this confidential and to send any questions to HR.`,
  },
  termination: {
    id: 'termination',
    label: 'Termination letter (employee)',
    audience: 'employee',
    withhold: [...HEALTH_PREFIXES],
    input: 'notes',
    instructions: `Write a respectful, factual termination letter to the employee.
State the reason only as supported by the notes, the effective date and next steps
(final pay, returning company property, benefits contact).
Never mention medical details.`,
  },
}

const COMMON_RULES = `You are an HR writing assistant. The case notes below are redacted:
placeholders like [EMPLOYEE_1], [ROLE_1] or [MEDICAL_DETAIL_1] stand for hidden details.
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

/**
 * The cloud prompt for a manager email. It holds the employee placeholder and the approved work
 * restrictions and NOTHING else: no case notes, no diagnosis, not even a [MEDICAL_DETAIL_n].
 */
export function buildManagerPrompt(employee: string, restrictions: string[]): string {
  const list = restrictions
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n')
  return `You are an HR writing assistant. You are given only an employee placeholder and the approved
work restrictions below.
Rules:
- Keep the placeholder ${employee} exactly as written, with its brackets and number.
- Use ONLY the restrictions listed. Do not add, widen or explain them.
- Never guess or mention why the employee needs them. Do not mention health, medical issues,
  disability, diagnosis, treatment or doctors in any way.
- Never create new placeholders. Write "____" for anything not given (dates, times, names).
- Neutral, professional tone. Plain text, no markdown.

Task:
${TEMPLATES.accommodation.instructions}

Employee: ${employee}
Approved work restrictions and accommodations:
${list}`
}

const AUDIENCE_LABEL: Record<Template['audience'], string> = {
  'hr-file': 'an HR file',
  manager: 'a manager',
  employee: 'an employee',
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
    warnings.push(`Withheld ${n} ${prefix} detail(s): not allowed in ${AUDIENCE_LABEL[template.audience]} draft.`)
  }
  if (invented.size) {
    warnings.push(`The draft used placeholders that don't exist: ${[...invented].join(', ')}. Check those lines.`)
  }
  if (template.input === 'restrictions') {
    const health = healthWording(draft)
    if (health) warnings.push(`The draft uses health wording ("${health}"). A manager email must say what is needed, not why. Remove it.`)
  }
  return { text: draft, warnings }
}
