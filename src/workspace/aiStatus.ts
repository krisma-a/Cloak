// What the header pill and the "Hiding details" card say about the AI that checks notes on this laptop.
// Pure (no React, no Firebase), so tests run in Node. App.tsx feeds it what ai.ts reports.
//
//   stage       which model is being loaded: "nano" (Gemini Nano, the private AI) or "basic" (the backup:
//               a smaller model plus rules, used when Nano is not available or the person chose not to wait)
//   mode        what the pill shows: "downloading" | "ready" | "basic" (null = not known yet, so no pill)
//   background  the person chose "Use basic checks for now", so Nano is still downloading behind the scenes
//   nanoReady   Nano is on this laptop and loaded, so the NEXT check will use it
//
// The pill says what is available to check notes right now. "Downloading" only ever means a REAL Nano download
// the person is waiting on. Chrome reports progress only while it is downloading, so a model that is already on
// this laptop goes straight to "ready".

import type { Engine } from '../ai/redact.ts'

export type AiMode = 'downloading' | 'ready' | 'basic'
export type AiStage = 'nano' | 'basic'

export interface AiState {
  mode: AiMode | null
  stage: AiStage | null
  background: boolean
  nanoReady: boolean
}

export const INITIAL_AI_STATE: AiState = { mode: null, stage: null, background: false, nanoReady: false }

export type AiEvent =
  /** Which model is about to load. Sent before anything is downloaded. */
  | { type: 'stage'; stage: AiStage }
  /** Download progress, 0 to 1, from the model that is loading. */
  | { type: 'progress'; fraction: number }
  /**
   * An engine is ready (after any download), or the notes have been checked. `engine` is the one that really
   * runs, which can differ from the plan if Nano failed to load.
   */
  | { type: 'engine'; engine: Engine }
  /** The person chose "Use basic checks for now": stop waiting, keep the Nano download going. */
  | { type: 'skip' }
  /** The download that was skipped has ended. `engine` is "nano" if the private AI is now ready. */
  | { type: 'background-done'; engine: Engine }
  /** Redaction threw. */
  | { type: 'failed' }

export function nextAiState(state: AiState, event: AiEvent): AiState {
  switch (event.type) {
    case 'stage':
      // Without Nano the notes get the basic checks, so that is already the real mode.
      return event.stage === 'basic' ? { ...state, mode: 'basic', stage: 'basic' } : { ...state, stage: 'nano' }
    case 'progress':
      return state.stage === 'nano' && event.fraction > 0 && event.fraction < 1 ? { ...state, mode: 'downloading' } : state
    case 'engine': {
      // Nano may have finished in the background while a basic check ran, and it is then what is ready.
      const nanoReady = state.nanoReady || event.engine === 'nano'
      return { ...state, mode: nanoReady ? 'ready' : 'basic', stage: null, nanoReady }
    }
    case 'skip':
      return { ...state, mode: 'basic', stage: 'basic', background: true }
    case 'background-done': {
      const nanoReady = state.nanoReady || event.engine === 'nano'
      return { ...state, background: false, nanoReady, mode: nanoReady ? 'ready' : (state.mode ?? 'basic') }
    }
    case 'failed':
      // Do not leave "Downloading…" up after a failure. A mode that was already known stays.
      return { ...state, mode: state.mode === 'downloading' ? null : state.mode, stage: null }
  }
}

export const PILL_TEXT: Record<AiMode, string> = {
  ready: 'Private AI ready',
  downloading: 'Downloading private AI…',
  basic: 'Basic checks',
}

/** The pill's tooltip: what the mode means. */
export const PILL_HELP: Record<AiMode, string> = {
  ready: 'Your notes are checked by Gemini Nano, a private AI that runs on this laptop.',
  downloading: 'Downloading the private AI to this laptop. This only happens the first time.',
  basic:
    'The private AI (Gemini Nano) isn’t available here, so your notes are checked with basic rules and a smaller model on this laptop. These checks are less thorough, so please read your notes carefully.',
}

const PILL_HELP_BACKGROUND =
  'Basic checks are in use for now. The private AI (Gemini Nano) is still downloading in the background, and will be used the next time you hide details.'

/** The tooltip for the current state, or null while there is no pill. */
export function pillHelp(state: AiState): string | null {
  if (state.mode === null) return null
  return state.mode === 'basic' && state.background ? PILL_HELP_BACKGROUND : PILL_HELP[state.mode]
}

/** What the "Hiding details" card says next to the percentage, for the model that is downloading. */
export function downloadLabel(stage: AiStage | null): string {
  return stage === 'basic'
    ? 'Downloading the basic checker (first time only)…'
    : 'Downloading the private AI (first time only, about 4 GB)…'
}

/** The button on the card while the private AI downloads, and the line under it. */
export const SKIP_LABEL = 'Use basic checks for now'
export const SKIP_HINT = 'The private AI keeps downloading, and is used next time.'
