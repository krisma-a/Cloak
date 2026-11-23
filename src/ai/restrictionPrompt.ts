// Turns medical details into functional work restrictions. Pure (no Firebase), so tests run in Node.
// restrict.ts runs the prompt on Gemini Nano (ONLY_ON_DEVICE); everything else here is plain code.
//
// Why: 29 CFR 1630.14(c)(1) keeps medical information in separate confidential files, with one
// exception for managers: they "may be informed regarding necessary restrictions on the work or
// duties of the employee and necessary accommodations" ((c)(1)(i)). So a manager email may say
// WHAT the employee needs ("a short break every 2 hours"), never WHY (the diagnosis).
//   - The original detail stays on this device in the placeholder map as [MEDICAL_DETAIL_n].
//   - A manager-email prompt is built from the approved restrictions only (not the case notes).
//   - Code checks every restriction for health wording and private details; the HR user approves.

import { findLeaks } from '../rules/rules.ts'
import { HEALTH_PREFIXES, restore, sensitiveStrings, type PlaceholderMap } from './placeholders.ts'
import { medicalTerms } from './ruleEntities.ts'

export const RESTRICTION_KINDS = [
  'BREAKS',
  'SCHEDULE',
  'TIME_OFF',
  'LIFTING',
  'STANDING_SITTING',
  'WORKSTATION',
  'DUTIES',
  'REMOTE_WORK',
  'OTHER',
] as const
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number]

export interface Restriction {
  kind: RestrictionKind
  /** One short functional line, e.g. "a short break every 2 hours". No reason, no diagnosis. */
  text: string
}

/** What the HR user approves for a manager email. */
export interface AccommodationPlan {
  /** The employee's placeholder, e.g. "[EMPLOYEE_1]". */
  employee: string
  restrictions: string[]
}

// JSON schema Nano must follow (Chrome Prompt API responseConstraint).
export const RESTRICTION_SCHEMA = {
  type: 'object',
  properties: {
    restrictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...RESTRICTION_KINDS] },
          text: { type: 'string' },
        },
        required: ['kind', 'text'],
      },
    },
  },
  required: ['restrictions'],
}

export const RESTRICTION_INSTRUCTIONS = `You turn HR notes about an employee's health into work restrictions that a manager may be told.
A manager may learn WHAT the employee needs at work, never WHY.
Return JSON: {"restrictions":[{"kind":"...","text":"..."}]}.
Kinds: ${RESTRICTION_KINDS.join(', ')}.
Rules:
- Describe only what the employee can or cannot do at work, or the change that is needed:
  breaks, schedule, time off, lifting, standing or sitting, workstation, duties, remote work.
- Use only restrictions or accommodations the notes state or request. Never work them out
  from the condition, and never add limits the notes do not mention.
- NEVER name or hint at a diagnosis, condition, symptom, medication, treatment, doctor or the reason.
  This includes a family member's condition.
- Write each text as one short plain line. No names, no placeholders.
- If the notes state no restriction, return {"restrictions":[]}.
Examples:
"She has type 2 diabetes and needs a short break every 2 hours." ->
{"restrictions":[{"kind":"BREAKS","text":"a short break every 2 hours"}]}
"After back surgery he cannot lift over 20 lbs and should not stand for long periods." ->
{"restrictions":[{"kind":"LIFTING","text":"no lifting over 20 lbs"},{"kind":"STANDING_SITTING","text":"no long periods of standing"}]}
"Her mother's dialysis means she has to leave at 3 pm on Tuesdays." ->
{"restrictions":[{"kind":"SCHEDULE","text":"leave at 3 pm on Tuesdays"}]}`

/**
 * The notes for Nano: only the health placeholders are put back to their original text, so the
 * model sees what the restriction is about. Names, contacts and pay stay hidden. On this device only.
 */
export function healthContext(redactedText: string, map: PlaceholderMap): string {
  return restore(redactedText, map, [], HEALTH_PREFIXES)
}

export function buildRestrictionPrompt(context: string): string {
  return `${RESTRICTION_INSTRUCTIONS}\n\nNotes:\n<<<\n${context}\n>>>`
}

/** Reads Nano's reply. Tolerates stray text around the JSON; an unknown kind becomes OTHER. */
export function parseRestrictions(raw: string): Restriction[] {
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
  const list = (data as { restrictions?: unknown })?.restrictions
  if (!Array.isArray(list)) return []
  return list.flatMap((r): Restriction[] => {
    if (typeof r?.text !== 'string' || !r.text.trim()) return []
    const kind = String(r.kind ?? '').trim().toUpperCase() as RestrictionKind
    return [{ kind: RESTRICTION_KINDS.includes(kind) ? kind : 'OTHER', text: r.text.trim() }]
  })
}

// Words that hint at a health reason. A word list can't be complete; it is one layer next to the
// model's instructions and the HR user's review. "working conditions" is allowed.
const HEALTH_WORDS = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:' +
    [
      'diagnos\\w*', '(?<!working\\s)conditions?', 'diseases?', 'disorders?', 'illness(?:es)?', 'sick\\w*',
      'symptoms?', 'medications?', 'medicines?', 'prescri\\w+', 'treatments?', 'therap\\w+', 'doctors?',
      'physicians?', 'clinic\\w*', 'hospital\\w*', 'medical\\w*', 'health\\w*', 'disabilit\\w+', 'disabled',
      'impair\\w+', 'injur\\w+', 'surger\\w+', 'blood sugar', 'glucose', 'chronic', 'pain(?:ful)?',
      'flare[- ]?ups?', 'pregnan\\w+',
    ].join('|') +
    ')(?![\\p{L}\\p{N}])',
  'iu',
)

/** The first health-related word in `text`, or null. */
export function healthWording(text: string): string | null {
  return text.match(HEALTH_WORDS)?.[0] ?? medicalTerms(text)[0]?.text ?? null
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/\p{L}{5,}/gu) ?? []

/** Long words from the hidden health details that the visible notes do not already use. */
function hiddenHealthWords(map: PlaceholderMap, redactedText: string): Set<string> {
  const visible = new Set(wordsOf(redactedText))
  const hidden = new Set<string>()
  for (const [placeholder, original] of Object.entries(map.originals)) {
    const prefix = placeholder.slice(1, placeholder.lastIndexOf('_'))
    if (!(HEALTH_PREFIXES as readonly string[]).includes(prefix)) continue
    for (const word of wordsOf(original)) if (!visible.has(word)) hidden.add(word)
  }
  return hidden
}

/** Why a restriction is not safe for a manager email, or null if it is. The reason stays on this device. */
export function restrictionProblem(text: string, map: PlaceholderMap, redactedText: string): string | null {
  const t = text.trim()
  if (t.length < 3) return 'too short'
  if (t.length > 160) return 'too long (keep each restriction to one short line)'
  if (/[[\]]/.test(t)) return 'contains a placeholder or brackets'
  // Strict: pay is rejected here even when redact_salary is off (a manager email never gets money).
  const leak = findLeaks(t, sensitiveStrings(map), { ignorePolicy: true })[0]
  if (leak) return `contains a private detail ("${leak.text}")`
  const hidden = hiddenHealthWords(map, redactedText)
  const word = wordsOf(t).find((w) => hidden.has(w))
  if (word) return `repeats a hidden health detail ("${word}")`
  const health = healthWording(t)
  if (health) return `health wording ("${health}"): say what is needed, not why`
  return null
}

/** Keeps the safe, distinct restrictions (at most 8). `dropped` counts the rest; their text is not kept. */
export function cleanRestrictions(
  items: Restriction[],
  map: PlaceholderMap,
  redactedText: string,
): { kept: Restriction[]; dropped: number } {
  const kept: Restriction[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const item of items) {
    const key = item.text.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (kept.length >= 8 || restrictionProblem(item.text, map, redactedText)) dropped++
    else kept.push({ kind: item.kind, text: item.text.trim() })
  }
  return { kept, dropped }
}

/** Why a manager email can't be drafted from this plan, or null. Checked again right before sending. */
export function accommodationBlockReason(
  plan: AccommodationPlan | undefined,
  map: PlaceholderMap,
  redactedText: string,
): string | null {
  if (!plan || !plan.restrictions.some((r) => r.trim())) {
    return 'Not sent: add at least one work restriction. A manager email uses only restrictions.'
  }
  if (!plan.employee.startsWith('[EMPLOYEE_') || map.originals[plan.employee] === undefined) {
    return 'Not sent: choose which employee the restrictions are for.'
  }
  for (const [i, r] of plan.restrictions.entries()) {
    if (!r.trim()) continue
    const problem = restrictionProblem(r, map, redactedText)
    if (problem) return `Not sent: restriction ${i + 1} ${problem}.`
  }
  return null
}
