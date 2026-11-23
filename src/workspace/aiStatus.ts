// What the header pill and the "Hiding details" card say about the AI that checks notes on this laptop.
// Pure (no React, no Firebase), so tests run in Node. App.tsx feeds it what redact.ts reports.
//
//   stage     which model is being loaded: "nano" (Gemini Nano, the private AI) or "simpler" (the backup:
//             a smaller model plus rules, used when Nano is not available)
//   mode      what the pill shows: "downloading" | "ready" | "simpler" (null = not known yet, so no pill)
//
// "Downloading" only ever means a REAL Nano download in progress. Chrome reports progress only while it
// is downloading, so a model that is already on this laptop goes straight to "ready".

import type { Engine } from '../ai/redact.ts'

export type AiMode = 'downloading' | 'ready' | 'simpler'
export type AiStage = 'nano' | 'simpler'

export interface AiState {
  mode: AiMode | null
  stage: AiStage | null
}

export const INITIAL_AI_STATE: AiState = { mode: null, stage: null }

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
  /** Redaction threw. */
  | { type: 'failed' }

export function nextAiState(state: AiState, event: AiEvent): AiState {
  switch (event.type) {
    case 'stage':
      // Without Nano the notes get the simpler checks, so that is already the real mode.
      return event.stage === 'simpler' ? { mode: 'simpler', stage: 'simpler' } : { ...state, stage: 'nano' }
    case 'progress':
      return state.stage === 'nano' && event.fraction > 0 && event.fraction < 1 ? { ...state, mode: 'downloading' } : state
    case 'engine':
      return { mode: event.engine === 'nano' ? 'ready' : 'simpler', stage: null }
    case 'failed':
      // Do not leave "Downloading…" up after a failure. A mode that was already known stays.
      return { mode: state.mode === 'downloading' ? null : state.mode, stage: null }
  }
}

export const PILL_TEXT: Record<AiMode, string> = {
  ready: 'Private AI ready',
  downloading: 'Downloading private AI…',
  simpler: 'Simpler checks',
}

/** The pill's tooltip: what the mode means. */
export const PILL_HELP: Record<AiMode, string> = {
  ready: 'Your notes are checked by Gemini Nano, a private AI that runs on this laptop.',
  downloading: 'Downloading the private AI to this laptop. This only happens the first time.',
  simpler:
    'The private AI (Gemini Nano) is not available here, so your notes are checked with simpler rules and a smaller model on this laptop. Please read them carefully.',
}

/** What the "Hiding details" card says next to the percentage, for the model that is downloading. */
export function downloadLabel(stage: AiStage | null): string {
  return stage === 'simpler'
    ? 'Downloading the simpler checker (first time only)…'
    : 'Downloading the private AI (first time only)…'
}
