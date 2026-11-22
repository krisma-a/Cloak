// The on-device redaction prompt and the JSON schema Gemini Nano must follow.
// Pure (no Firebase), so tests run in Node. redact.ts sends these to Nano (ONLY_ON_DEVICE).

import { CATEGORIES, type Category, type Entity } from './placeholders.ts'

// JSON schema Nano must follow (Chrome Prompt API responseConstraint). The category enum comes
// from CATEGORIES, so ROLE, DEPARTMENT, TENURE and FAMILY_MEDICAL are allowed answers.
export const ENTITY_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
        },
        required: ['text', 'category'],
      },
    },
  },
  required: ['entities'],
}

export const INSTRUCTIONS = `You find personal information in HR case notes so it can be hidden.
The company has 50 to 500 people, so a detail that fits only one or two people
identifies them as surely as a name.
Return JSON: {"entities":[{"text":"...","category":"..."}]}.
Copy each "text" exactly as it appears in the notes.

Direct identifiers:
- PERSON: any person's name, including first names alone, nicknames and initials.
- EMPLOYEE_ID: employee or badge numbers.
- EMAIL, PHONE, ADDRESS: contact details.
- MEDICAL: the employee's own diagnoses, conditions, disabilities, medications, pregnancy, treatments.
- SALARY: pay, wages, bonuses or other money amounts tied to a person.
- DATE_OF_BIRTH: birth dates or exact ages.
- OTHER_ID: SSN, passport, tax or any other ID number.

Indirect identifiers (details that point to one person). Always include these:
- ROLE: a job or description that fits only one person, or very few:
  "the only night-shift forklift lead", "the sole payroll analyst", "the only woman",
  "the only Filipino nurse", "the youngest engineer", "the new hire from Lagos",
  or a title one person holds: "the plant manager", "the head of payroll".
- DEPARTMENT: the team, unit, shift, site or branch that goes with it:
  "the Reno warehouse", "the night warehouse crew", "the ICU", "Cebu branch".
  Never meetings, calls or other events.
- TENURE: how long someone has worked there or when they started, when it is unusual
  or tied to a team: "28-year veteran", "hired in 1996", "the longest-serving driver",
  "started last week".
- FAMILY_MEDICAL: a medical detail about a relative or partner. Copy the whole phrase,
  including whose it is: "her mother's dialysis", "his son's autism diagnosis".

When a role or tenure appears with its team, return them as two entities, not one:
"the only night-shift forklift lead in the Reno warehouse" ->
{"text":"the only night-shift forklift lead","category":"ROLE"},
{"text":"the Reno warehouse","category":"DEPARTMENT"}
"a 28-year veteran in Treasury" ->
{"text":"28-year veteran","category":"TENURE"},
{"text":"Treasury","category":"DEPARTMENT"}

Do not include: job titles many people share, used without "only", "sole" or the like
("a cashier", "the drivers"), job duties, policies, work restrictions, or dates of events.
Ignore placeholders in square brackets like [EMPLOYEE_1]; they are already hidden.`

export function buildPrompt(text: string, missed: string[]): string {
  const hint = missed.length
    ? `\nYour last answer missed these. Include each one with the right category: ${missed
        .map((m) => JSON.stringify(m))
        .join(', ')}\n`
    : ''
  return `${INSTRUCTIONS}\n${hint}\nNotes:\n<<<\n${text}\n>>>`
}

/** Reads Nano's reply. Tolerates stray text around the JSON and lower-case categories. */
export function parseEntities(raw: string): Entity[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return []
    try {
      data = JSON.parse(match[0])
    } catch {
      return []
    }
  }
  const list = (data as { entities?: unknown })?.entities
  if (!Array.isArray(list)) return []
  return list.flatMap((e): Entity[] => {
    if (typeof e?.text !== 'string' || typeof e?.category !== 'string') return []
    const category = e.category.trim().toUpperCase() as Category
    return CATEGORIES.includes(category) ? [{ text: e.text, category }] : []
  })
}
