// On-device redaction. Raw case text goes ONLY to Gemini Nano on this laptop.
//   1. Nano finds sensitive entities and returns them as JSON.
//   2. placeholders.ts swaps them for [EMPLOYEE_1]-style placeholders.
//   3. rules.ts re-checks the result. Misses go back to Nano (max 2 retries).
//   4. Anything still leaking -> status "blocked": the text must not go to the cloud.
// If Nano is not available -> status "unavailable" (the app switches to Strict mode).

import type { GenerativeModel } from 'firebase/ai'
import { getRedactionModel } from '../firebase'
import { findLeaks, type Leak } from '../rules/rules.ts'
import {
  applyEntities,
  CATEGORIES,
  countByPrefix,
  emptyMap,
  sensitiveStrings,
  type Category,
  type Entity,
  type PlaceholderMap,
} from './placeholders.ts'

export const MAX_RETRIES = 2 // later read from Remote Config

export type RedactionStatus = 'ok' | 'blocked' | 'unavailable'

export interface RedactionResult {
  status: RedactionStatus
  redactedText: string
  map: PlaceholderMap
  /** Leaks still present (empty when status is "ok"). Stays in the browser. */
  leaks: Leak[]
  /** Model calls made, including retries. */
  attempts: number
  /** Where the last model call ran. Should always be "on_device". */
  ranOn?: string
  /** Placeholders per type, e.g. { EMPLOYEE: 2 }. Safe for the audit log. */
  counts: Record<string, number>
  error?: string
}

// JSON schema Nano must follow (Chrome Prompt API responseConstraint).
const ENTITY_SCHEMA = {
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

const INSTRUCTIONS = `You find personal information in HR case notes so it can be hidden.
Return JSON: {"entities":[{"text":"...","category":"..."}]}.
Copy each "text" exactly as it appears in the notes.
Categories:
- PERSON: any person's name, including first names alone, nicknames and initials.
- EMPLOYEE_ID: employee or badge numbers.
- EMAIL, PHONE, ADDRESS: contact details.
- MEDICAL: diagnoses, conditions, disabilities, medications, pregnancy, treatments.
- SALARY: pay, wages, bonuses or other money amounts tied to a person.
- DATE_OF_BIRTH: birth dates or exact ages.
- ROLE: a whole phrase that singles out one person. Always include these. Examples:
  "the only woman on the night warehouse crew", "the only Filipino nurse in the ICU",
  "the youngest engineer", "the new hire from Lagos". Copy the full phrase, including the team.
- DEPARTMENT: a team, unit or site name that narrows down who someone is, e.g.
  "the night warehouse crew", "Cebu branch". Never meetings, calls or other events.
- OTHER_ID: SSN, passport, tax or any other ID number.
Ignore placeholders in square brackets like [EMPLOYEE_1]; they are already hidden.
Do not include job duties, policies or dates of events.`

function buildPrompt(text: string, missed: string[]): string {
  const hint = missed.length
    ? `\nYour last answer missed these. Include each one with the right category: ${missed
        .map((m) => JSON.stringify(m))
        .join(', ')}\n`
    : ''
  return `${INSTRUCTIONS}\n${hint}\nNotes:\n<<<\n${text}\n>>>`
}

function parseEntities(raw: string): Entity[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/) // tolerate stray text around the JSON
    if (!match) return []
    try {
      data = JSON.parse(match[0])
    } catch {
      return []
    }
  }
  const list = (data as { entities?: unknown })?.entities
  if (!Array.isArray(list)) return []
  return list.filter(
    (e): e is Entity =>
      typeof e?.text === 'string' && CATEGORIES.includes(e?.category as Category),
  )
}

let model: GenerativeModel | undefined
function redactionModel(): GenerativeModel {
  model ??= getRedactionModel({ promptOptions: { responseConstraint: ENTITY_SCHEMA } })
  return model
}

/**
 * Downloads/loads Gemini Nano. Call this from a button click (Chrome requires a user action).
 * Throws if the device cannot run Nano.
 */
export async function prepareRedaction(onProgress?: (fraction: number) => void): Promise<void> {
  await redactionModel().initializeDeviceModel(onProgress)
}

/** Redacts `text` on-device. Never sends `text` to the cloud. */
export async function redact(
  text: string,
  options: { maxRetries?: number; knownNames?: string[] } = {},
): Promise<RedactionResult> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let map = emptyMap()
  let current = text
  let missed: string[] = []
  let leaks: Leak[] = []
  let ranOn: string | undefined
  let attempts = 0

  for (let i = 0; i <= maxRetries; i++) {
    attempts++
    try {
      const result = await redactionModel().generateContent(buildPrompt(current, missed))
      ranOn = result.response.inferenceSource
      ;({ text: current, map } = applyEntities(current, parseEntities(result.response.text()), map))
    } catch (e) {
      // Most often: Nano is not available on this device/browser.
      return {
        status: 'unavailable',
        redactedText: '',
        map: emptyMap(),
        leaks: [],
        attempts,
        counts: {},
        error: e instanceof Error ? e.message : String(e),
      }
    }

    leaks = findLeaks(current, [...sensitiveStrings(map), ...(options.knownNames ?? [])])
    if (leaks.length === 0) {
      return { status: 'ok', redactedText: current, map, leaks, attempts, ranOn, counts: countByPrefix(map) }
    }
    missed = leaks.map((l) => l.text)
  }

  return { status: 'blocked', redactedText: current, map, leaks, attempts, ranOn, counts: countByPrefix(map) }
}
