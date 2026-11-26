// The review screen's logic. Pure functions (no React, no Firebase), so tests run in Node.
//
// Two pieces of state drive the screen:
//   base  the redaction with EVERY detail still a placeholder (the full map stays in memory)
//   kept  placeholders the person chose to leave visible
// What would be sent is outgoing(base, kept): kept details written back in, and dropped from the map.

import { applyEntities, countByPrefix, restore, sensitiveStrings } from '../ai/placeholders.ts'
import type { Category, PlaceholderMap } from '../ai/placeholders.ts'
import type { DraftResult } from '../ai/draft.ts'
import type { RedactionResult } from '../ai/redact.ts'
import { ruleEntities } from '../ai/ruleEntities.ts'
import { findLeaks } from '../rules/rules.ts'

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'detail'; placeholder: string; original: string; hidden: boolean }

export interface ReviewItem {
  placeholder: string
  original: string
  hidden: boolean
  count: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Leaks, status and counts always describe the text as it is now. */
export function refresh(result: RedactionResult): RedactionResult {
  const leaks = findLeaks(result.redactedText, sensitiveStrings(result.map))
  return { ...result, leaks, status: leaks.length ? 'blocked' : 'ok', counts: countByPrefix(result.map) }
}

/** What would be sent right now: kept details written back in, hidden ones still placeholders. */
export function outgoing(base: RedactionResult, kept: readonly string[]): RedactionResult {
  if (kept.length === 0) return refresh(base)
  const keptSet = new Set(kept)
  const originals: Record<string, string> = {}
  const keptOriginals: Record<string, string> = {}
  for (const [placeholder, value] of Object.entries(base.map.originals)) {
    if (keptSet.has(placeholder)) keptOriginals[placeholder] = value
    else originals[placeholder] = value
  }
  const lookup: Record<string, string> = {}
  for (const [key, placeholder] of Object.entries(base.map.lookup)) {
    if (!keptSet.has(placeholder)) lookup[key] = placeholder
  }
  // restore() writes the kept details back (and capitalises a phrase that starts a sentence).
  const redactedText = restore(base.redactedText, { originals: keptOriginals, lookup: {} })
  return refresh({ ...base, redactedText, map: { originals, lookup } })
}

/** The notes as a list of plain text and details, each detail hidden or kept. */
export function buildSegments(base: RedactionResult, kept: readonly string[]): Segment[] {
  const keys = Object.keys(base.map.originals).sort((a, b) => b.length - a.length)
  const text = base.redactedText
  if (keys.length === 0) return text ? [{ kind: 'text', text }] : []

  const keptSet = new Set(kept)
  const pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'g')
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) })
    const placeholder = match[0]
    segments.push({
      kind: 'detail',
      placeholder,
      original: base.map.originals[placeholder] ?? '',
      hidden: !keptSet.has(placeholder),
    })
    last = start + placeholder.length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

/** One row per distinct detail, in the order it first appears. */
export function reviewItems(segments: readonly Segment[]): ReviewItem[] {
  const items = new Map<string, ReviewItem>()
  for (const segment of segments) {
    if (segment.kind !== 'detail') continue
    const item = items.get(segment.placeholder)
    if (item) item.count += 1
    else {
      items.set(segment.placeholder, {
        placeholder: segment.placeholder,
        original: segment.original,
        hidden: segment.hidden,
        count: 1,
      })
    }
  }
  return [...items.values()]
}

/** Keep a detail visible, or hide it again. */
export function toggleKept(kept: readonly string[], placeholder: string): string[] {
  return kept.includes(placeholder) ? kept.filter((p) => p !== placeholder) : [...kept, placeholder]
}

/**
 * Hides a word or phrase the person picked, everywhere it appears, as whole words.
 * Uses the same code as the real redaction, so numbering and name parts behave the same.
 * Returns the same object when nothing changed.
 */
export function hideText(base: RedactionResult, text: string, category: Category, prefix?: string | null): RedactionResult {
  const target = text.trim()
  if (target.length < 2) return base
  const { text: redactedText, map } = applyEntities(base.redactedText, [{ text: target, category }], base.map)
  if (redactedText === base.redactedText) return base
  const hidden = refresh({ ...base, redactedText, map })
  if (!prefix) return hidden
  // "Other" with the person's own label: rename the new placeholder, e.g. [ID_3] -> [CLIENT_1].
  const added = Object.keys(hidden.map.originals).filter((p) => base.map.originals[p] === undefined)
  return added.reduce((result, placeholder) => renamePlaceholder(result, placeholder, prefix), hidden)
}

/**
 * The placeholder name for an "Other" label the person typed ("Client" -> "CLIENT", "client team" -> "CLIENT_TEAM"):
 * English letters and spaces only, 2 to 20 characters, or null when it can't be used.
 */
export function customPrefix(label: string): string | null {
  const words = label.trim().toUpperCase().split(/\s+/).filter(Boolean)
  const prefix = words.join('_')
  if (prefix.length < 2 || prefix.length > 20 || !/^[A-Z]+(?:_[A-Z]+)*$/.test(prefix)) return null
  return prefix
}

/**
 * True when a typed label would give away a hidden detail: the label is sent with the text, so it must not contain
 * (or be part of) anything that is hidden, like "Brightline" for a hidden "Brightline Health".
 */
export function labelGivesAway(label: string, base: RedactionResult, text = ''): boolean {
  const words = label.toLowerCase().trim()
  if (!words) return false
  const hidden = [...Object.keys(base.map.lookup), text.toLowerCase().trim()].filter((h) => h.length >= 3)
  return hidden.some((h) => words.includes(h) || h.includes(words))
}

/** Renames one placeholder everywhere (text, originals, lookup) to the next free number of `prefix`. */
function renamePlaceholder(result: RedactionResult, from: string, prefix: string): RedactionResult {
  let n = 1
  while (result.map.originals[`[${prefix}_${n}]`] !== undefined) n++
  const to = `[${prefix}_${n}]`
  const originals: Record<string, string> = {}
  for (const [p, original] of Object.entries(result.map.originals)) originals[p === from ? to : p] = original
  const lookup: Record<string, string> = {}
  for (const [key, p] of Object.entries(result.map.lookup)) lookup[key] = p === from ? to : p
  return refresh({ ...result, redactedText: result.redactedText.split(from).join(to), map: { originals, lookup } })
}

/**
 * Fixes whatever the leak check still sees: fixed-shape details (emails, phones, IDs, salary...)
 * that were missed get hidden, and a kept detail that trips the check goes back to hidden.
 */
export function fixLeaks(
  base: RedactionResult,
  kept: readonly string[],
): { base: RedactionResult; kept: string[] } {
  const now = outgoing(base, kept)
  if (now.leaks.length === 0) return { base, kept: [...kept] }

  const leakTexts = now.leaks.map((leak) => leak.text.toLowerCase())
  const stillKept = kept.filter((placeholder) => {
    const original = (base.map.originals[placeholder] ?? '').toLowerCase()
    return !leakTexts.some((text) => original.includes(text))
  })
  // Hiding with an empty list also re-applies every known detail across the whole text.
  const { text: redactedText, map } = applyEntities(base.redactedText, ruleEntities(base.redactedText), base.map)
  return { base: refresh({ ...base, redactedText, map }), kept: stillKept }
}

/** What to call each hidden detail on screen: [EMPLOYEE_1] -> "NAME 1", [MEDICAL_DETAIL_1] -> "MEDICAL". */
const WORDS: Record<string, string> = {
  EMPLOYEE: 'NAME',
  ID: 'ID',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  ADDRESS: 'ADDRESS',
  MEDICAL_DETAIL: 'MEDICAL',
  SALARY: 'SALARY',
  DOB: 'BIRTH DATE',
  ROLE: 'ROLE',
  DEPT: 'TEAM',
  TENURE: 'TENURE',
  FAMILY_MEDICAL: 'FAMILY MEDICAL',
}

/** Names are always numbered. Other details are numbered only when there is more than one kind. */
export function makeLabeler(map: PlaceholderMap): (placeholder: string) => string {
  const counts = countByPrefix(map)
  return (placeholder) => {
    const match = /^\[([A-Z_]+)_(\d+)\]$/.exec(placeholder)
    if (!match) return placeholder
    const prefix = match[1] ?? ''
    const word = WORDS[prefix] ?? prefix.replace(/_/g, ' ')
    return prefix === 'EMPLOYEE' || (counts[prefix] ?? 0) > 1 ? `${word} ${match[2]}` : word
  }
}

/** True while this tab holds anything that closing it would lose: case text, a redaction or a draft. */
export function hasWorkToLose(state: {
  notes: string
  base: RedactionResult | null
  draft: DraftResult | null
}): boolean {
  return state.notes.trim() !== '' || state.base !== null || state.draft !== null
}

export interface EmployeeOption {
  /** What the app keeps and sends: always the placeholder, e.g. "[EMPLOYEE_1]". */
  value: string
  /** What the person sees: the real name plus its label. Display only; never stored, logged or sent. */
  text: string
}

/** The "Who is this for?" choices: "Maria Lopez (sent as NAME 1)". Only names that are still hidden. */
export function employeeOptions(
  map: PlaceholderMap,
  label: (placeholder: string) => string,
): EmployeeOption[] {
  return Object.entries(map.originals)
    .filter(([placeholder]) => placeholder.startsWith('[EMPLOYEE_'))
    .map(([placeholder, original]) => ({ value: placeholder, text: `${original} (sent as ${label(placeholder)})` }))
}

/** What "Hide as" offers when the person picks their own words to hide. */
export const HIDE_CHOICES: ReadonlyArray<{ label: string; category: Category }> = [
  { label: 'Name', category: 'PERSON' },
  { label: 'Medical', category: 'MEDICAL' },
  { label: 'Money', category: 'SALARY' },
  { label: 'Address', category: 'ADDRESS' },
  { label: 'Other', category: 'OTHER_ID' },
]
