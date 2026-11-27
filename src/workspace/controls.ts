// Small pure helpers for the Back, Save, auto-clear and "write the draft?" controls.
// No Firebase and no DOM here, so `npm test` can run them. Fake data only in the tests.

import type { StepId } from './types.ts'

/** Where the Back button in the header goes. The start and scan screens have their own way back, so they say null. */
export function previousStep(step: StepId): StepId | null {
  switch (step) {
    case 'paste':
      return 'start'
    case 'review':
      return 'paste'
    case 'generate':
      return 'review'
    case 'result':
      return 'generate'
    default:
      return null
  }
}

// ---------- Auto-clear after no activity ----------
// Like the automatic log-off in healthcare and school systems: a laptop left open on a desk
// shouldn't keep case notes on screen. A warning comes first, and "Keep working" resets the clock.

export const IDLE_MINUTES = [15, 30, 60] as const
export type IdleMinutes = (typeof IDLE_MINUTES)[number]
export const DEFAULT_IDLE_MINUTES: IdleMinutes = 15
/** How long the warning stays up before everything is cleared. Long enough to react to (WCAG 2.2.1 asks for 20 s or more). */
export const IDLE_WARNING_SECONDS = 60

export interface IdleState {
  status: 'active' | 'warning' | 'expired'
  /** Seconds until everything is cleared, while status is "warning". */
  secondsLeft: number
}

export function idleStatus(
  now: number,
  lastActive: number,
  limitMinutes: number,
  warningSeconds = IDLE_WARNING_SECONDS,
): IdleState {
  const limitMs = limitMinutes * 60_000
  const idleMs = Math.max(0, now - lastActive)
  const warnAt = Math.max(0, limitMs - warningSeconds * 1000)
  if (idleMs >= limitMs) return { status: 'expired', secondsLeft: 0 }
  if (idleMs >= warnAt) return { status: 'warning', secondsLeft: Math.ceil((limitMs - idleMs) / 1000) }
  return { status: 'active', secondsLeft: Math.ceil((limitMs - idleMs) / 1000) }
}

// ---------- Saving the draft ----------

export type SaveFormat = 'pdf' | 'txt'

/** A file name with no names in it: the kind of case and the date, nothing from the notes. */
export function saveFileName(templateId: string, format: SaveFormat, date: Date): string {
  const kind = templateId.replace(/[^a-z-]/gi, '').toLowerCase() || 'case'
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
  return `cloak-${kind}-draft-${day}.${format}`
}

// ---------- The "Write the draft?" pop-up ----------

export interface WriteFacts {
  /** Details hidden behind labels. */
  hidden: number
  /** Details the person chose to leave visible. */
  kept: number
  /** Length of the text that would be sent. */
  characters: number
  /** True when the draft is a manager email: only the approved work restrictions go. */
  restrictionsOnly: boolean
  /** Real AI sends to the cloud. Demo sends nothing. */
  realAi: boolean
}

export interface WriteSummary {
  /** One line each: what leaves this laptop. */
  sent: string[]
  /** One line each: what stays. */
  stays: string[]
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** The plain-language receipt shown before anything is sent. */
export function writeSummary(facts: WriteFacts): WriteSummary {
  const stays = ['The real names and details', 'Your original notes']
  if (!facts.realAi) {
    return { sent: ['Nothing. This is a demo draft.'], stays }
  }
  const sent: string[] = []
  if (facts.restrictionsOnly) {
    sent.push('The work restrictions you approved', 'No case notes and no health details')
  } else {
    sent.push(`The hidden version of your notes (${plural(facts.characters, 'character', 'characters')})`)
    sent.push(
      facts.hidden === 0
        ? 'No labels: nothing was hidden'
        : `${plural(facts.hidden, 'private detail', 'private details')} shown only as labels`,
    )
    if (facts.kept > 0) {
      sent.push(`${plural(facts.kept, 'detail', 'details')} you chose to keep visible, exactly as written`)
    }
  }
  return { sent, stays }
}
