// Display logic for the "What you typed" vs "What the cloud saw" panels on the result screen.
// Pure (no React, no Firebase), so tests run in Node. This only DRAWS two views of text the app
// already has. It never changes what is redacted or sent, and the typed text never goes anywhere.
//
//   typed  the notes exactly as the person wrote them, with each private detail marked
//   sent   what the cloud was given (from the receipt), with each hidden detail as a placeholder
//
// Both lists tag a detail with the same `id` (its placeholder, e.g. "[EMPLOYEE_1]"), so the screen
// can light up a detail on one side and its match on the other.

import { findPlaceholders, type PlaceholderMap } from '../ai/placeholders.ts'
import type { RedactionResult } from '../ai/redact.ts'
import { TEMPLATES, type TemplateId } from '../ai/templates.ts'
import { makeLabeler } from './review.ts'

export type ComparePiece =
  | { kind: 'text'; text: string }
  /** A detail that was hidden. On the typed side `text` is the real value; on the sent side it is the placeholder. */
  | { kind: 'hidden'; id: string; text: string; label: string; sent: boolean }
  /** A detail the person chose to keep visible: it was sent as written. */
  | { kind: 'kept'; id: string; text: string }

export interface Comparison {
  typed: ComparePiece[]
  sent: ComparePiece[]
  /** What the cloud wrote back, with its placeholders still in place (names are restored on this laptop afterwards). */
  back: ComparePiece[]
  /** The part of the cloud prompt that comes from this case. Our fixed writing instructions are left out. */
  sentPayload: string
  /** Our fixed writing instructions: what came before and after the payload. before + payload + after is the whole prompt. */
  instructions: { before: string; after: string }
  /** True when the manager email was written: only approved restrictions were sent, never the notes. */
  restrictionsOnly: boolean
}

const WORD_START = '(?<![\\p{L}\\p{N}])'
const WORD_END = '(?![\\p{L}\\p{N}])'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Splits the prompt into our fixed instructions and the part that holds this case.
 * Mirrors buildDraftPrompt() and buildManagerPrompt() in templates.ts (a test keeps them in step).
 * If the shape is not recognised, everything counts as the case part, so nothing that was sent is hidden.
 */
export function splitSent(
  sentText: string,
  input: 'notes' | 'restrictions',
): { before: string; payload: string; after: string } {
  if (input === 'restrictions') {
    const at = sentText.indexOf('\nEmployee: ')
    if (at !== -1) return { before: sentText.slice(0, at + 1), payload: sentText.slice(at + 1), after: '' }
  } else {
    const start = sentText.indexOf('\n<<<\n')
    const end = sentText.lastIndexOf('\n>>>')
    if (start !== -1 && end > start) {
      return { before: sentText.slice(0, start + 5), payload: sentText.slice(start + 5, end), after: sentText.slice(end) }
    }
  }
  return { before: '', payload: sentText, after: '' }
}

/** Just the case part of the prompt. */
export function sentPayload(sentText: string, input: 'notes' | 'restrictions'): string {
  return splitSent(sentText, input).payload
}

/** Cuts `text` into plain text and matches of `pattern` (a whole-word, any-case alternation). */
function cut(text: string, pattern: RegExp | null, make: (match: string) => ComparePiece | null): ComparePiece[] {
  if (!pattern) return text ? [{ kind: 'text', text }] : []
  const pieces: ComparePiece[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const piece = make(match[0])
    if (!piece) continue
    if (match.index > last) pieces.push({ kind: 'text', text: text.slice(last, match.index) })
    pieces.push(piece)
    last = match.index + match[0].length
  }
  if (last < text.length) pieces.push({ kind: 'text', text: text.slice(last) })
  return pieces
}

function alternation(values: string[], whole: boolean, flags: string): RegExp | null {
  const unique = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length)
  if (unique.length === 0) return null
  const body = unique.map(escapeRegExp).join('|')
  return new RegExp(whole ? `${WORD_START}(?:${body})${WORD_END}` : body, flags)
}

export function buildComparison(input: {
  /** The notes as typed. */
  notes: string
  /** The redaction with every detail still a placeholder (the full map). */
  base: RedactionResult
  /** Placeholders the person chose to leave visible. */
  kept: readonly string[]
  /** receipt.sentText: exactly what went to the cloud. */
  sentText: string
  /** The draft as the cloud returned it, before real names were put back. */
  draftWithPlaceholders: string
  templateId: TemplateId
}): Comparison {
  const { notes, base, kept, sentText, draftWithPlaceholders, templateId } = input
  const inputKind = TEMPLATES[templateId].input
  const { before, payload, after } = splitSent(sentText, inputKind)
  const label = makeLabeler(base.map)
  const keptSet = new Set(kept)

  // Typed side: find every spelling the redaction hid (full names, name parts, ...) in the typed text.
  const typedPattern = alternation(Object.keys(base.map.lookup), true, 'giu')
  const typed = cut(notes, typedPattern, (match) => {
    const id = base.map.lookup[match.toLowerCase()]
    if (id === undefined) return null
    return keptSet.has(id)
      ? { kind: 'kept', id, text: match }
      : { kind: 'hidden', id, text: match, label: label(id), sent: payload.includes(id) }
  })

  // Sent side: the placeholders in what was sent, and any detail that was kept and so went as written.
  const hiddenIds = Object.keys(base.map.originals).filter((id) => !keptSet.has(id))
  const keptByText = new Map<string, string>()
  for (const id of kept) {
    const original = base.map.originals[id]
    if (original) keptByText.set(original.toLowerCase(), id)
  }
  const sentPattern = new RegExp(
    [
      hiddenIds.length ? `(?:${[...hiddenIds].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})` : '',
      keptByText.size
        ? `${WORD_START}(?:${[...keptByText.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})${WORD_END}`
        : '',
    ]
      .filter(Boolean)
      .join('|') || '(?!)',
    'giu',
  )
  const sent = cut(payload, sentPattern, (match) => {
    if (base.map.originals[match] !== undefined && !keptSet.has(match)) {
      return { kind: 'hidden', id: match, text: match, label: label(match), sent: true }
    }
    const keptId = keptByText.get(match.toLowerCase())
    return keptId === undefined ? null : { kind: 'kept', id: keptId, text: match }
  })

  return {
    typed,
    sent,
    back: cutDraft(draftWithPlaceholders, base.map, label),
    sentPayload: payload,
    instructions: { before, after },
    restrictionsOnly: inputKind === 'restrictions',
  }
}

/**
 * The cloud's draft as it came back: each placeholder it used becomes a label, however the model
 * formatted it ("[ employee 1 ]" too). A look-alike that is not one of ours stays plain text.
 */
function cutDraft(draft: string, map: PlaceholderMap, label: (placeholder: string) => string): ComparePiece[] {
  const pieces: ComparePiece[] = []
  let cursor = 0
  for (const found of findPlaceholders(draft, map)) {
    if (!found.known) continue
    const at = draft.indexOf(found.raw, cursor)
    if (at === -1) continue
    if (at > cursor) pieces.push({ kind: 'text', text: draft.slice(cursor, at) })
    pieces.push({ kind: 'hidden', id: found.placeholder, text: found.raw, label: label(found.placeholder), sent: true })
    cursor = at + found.raw.length
  }
  if (cursor < draft.length) pieces.push({ kind: 'text', text: draft.slice(cursor) })
  return pieces
}
