// The send guard and the name check. Pure functions (no Firebase), so tests run in Node.
//
// Rules can't recognise names. When no name model ran (rules-only engine), `names` is
// "unchecked" and nothing may be sent until the user either lists the names in the case
// (they get hidden here) or confirms there are none.

import { findLeaks } from '../rules/rules.ts'
import { applyEntities, countByPrefix, sensitiveStrings } from './placeholders.ts'
import type { RedactionResult } from './redact.ts'

/** Why this text may not leave the device (even by a cloud fallback), or null if it may. */
export function redactionBlockReason(redaction: RedactionResult): string | null {
  if (redaction.status !== 'ok') return 'Not sent: redaction is blocked (something still leaks).'
  if (redaction.names === 'unchecked') {
    return 'Not sent: names have not been checked. Enter the names in this case, or confirm there are none.'
  }
  const leaks = findLeaks(redaction.redactedText, sensitiveStrings(redaction.map))
  if (leaks.length) return `Not sent: the leak re-check found ${leaks.length} item(s) still visible.`
  return null
}

/** Why nothing may be sent, or null if it may. Used by draft() before any cloud call. */
export function sendBlockReason(redaction: RedactionResult, approved: boolean): string | null {
  if (!approved) return 'Not sent: the user has not approved the redacted text.'
  return redactionBlockReason(redaction)
}

/** "Maria Santos, Chidi Okafor" or one per line -> ["Maria Santos", "Chidi Okafor"]. */
export function splitNames(input: string): string[] {
  const names = input
    .split(/[,;\n]+/)
    .map((n) => n.trim())
    .filter((n) => n.length >= 2)
  return [...new Set(names)]
}

/**
 * Hides names the user typed (full names and their parts) in the already-redacted text,
 * re-checks for leaks, and marks names as checked by the user.
 */
export function hideNames(result: RedactionResult, names: string[]): RedactionResult {
  const entities = names.map((text) => ({ text, category: 'PERSON' as const }))
  const { text, map } = applyEntities(result.redactedText, entities, result.map)
  const leaks = findLeaks(text, sensitiveStrings(map))
  return {
    ...result,
    redactedText: text,
    map,
    leaks,
    status: leaks.length ? 'blocked' : 'ok',
    counts: countByPrefix(map),
    names: 'user',
  }
}

/** The user states the note has no names left to hide. Recorded in the receipt. */
export function confirmNoNames(result: RedactionResult): RedactionResult {
  return { ...result, names: 'user' }
}
