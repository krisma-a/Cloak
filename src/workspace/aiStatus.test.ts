// Run with: npm test   (no data involved)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  downloadLabel,
  INITIAL_AI_STATE,
  nextAiState,
  PILL_HELP,
  PILL_TEXT,
  type AiEvent,
  type AiState,
} from './aiStatus.ts'

const run = (events: AiEvent[], from: AiState = INITIAL_AI_STATE): AiState => events.reduce(nextAiState, from)

test('the pill says nothing until the mode is known', () => {
  assert.deepEqual(INITIAL_AI_STATE, { mode: null, stage: null })
  // Nano can run here, but nothing is downloaded or loaded yet: still not known.
  assert.equal(run([{ type: 'stage', stage: 'nano' }]).mode, null)
})

test('a first-time Nano download shows "downloading", then "ready" as soon as the engine is ready', () => {
  const states: AiState[] = []
  let state = INITIAL_AI_STATE
  for (const event of [
    { type: 'stage', stage: 'nano' },
    { type: 'progress', fraction: 0.02 },
    { type: 'progress', fraction: 0.6 },
    { type: 'progress', fraction: 1 },
    { type: 'engine', engine: 'nano' }, // prepareRedaction finished: ready, before the notes are even checked
  ] as AiEvent[]) {
    state = nextAiState(state, event)
    states.push(state)
  }
  assert.deepEqual(states.map((s) => s.mode), [null, 'downloading', 'downloading', 'downloading', 'ready'])
  assert.equal(states.at(-1)?.stage, null)
})

test('a model that is already on this laptop never shows "downloading"', () => {
  // Chrome reports no progress when nothing is downloaded, so the events are just stage then finished.
  assert.deepEqual(run([{ type: 'stage', stage: 'nano' }, { type: 'engine', engine: 'nano' }]), { mode: 'ready', stage: null })
  // Progress of exactly 0 or 1 is not "in the middle of a download".
  assert.equal(run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0 }]).mode, null)
  assert.equal(run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 1 }]).mode, null)
  assert.equal(run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: Number.NaN }]).mode, null)
})

test('without Nano it is "simpler" straight away, and a download then is not called the private AI', () => {
  const state = run([{ type: 'stage', stage: 'simpler' }, { type: 'progress', fraction: 0.4 }])
  assert.deepEqual(state, { mode: 'simpler', stage: 'simpler' })
  assert.equal(downloadLabel(state.stage), 'Downloading the simpler checker (first time only)…')
  assert.equal(run([{ type: 'stage', stage: 'simpler' }, { type: 'engine', engine: 'browser-model' }]).mode, 'simpler')
  assert.equal(run([{ type: 'engine', engine: 'rules-only' }]).mode, 'simpler')
})

test('the engine that really ran decides the final mode, even if Nano failed on the way', () => {
  const state = run([
    { type: 'stage', stage: 'nano' },
    { type: 'progress', fraction: 0.5 },
    { type: 'engine', engine: 'browser-model' }, // Nano broke, so redact() used the backup engine
  ])
  assert.equal(state.mode, 'simpler')
})

test('a failure clears "downloading" but keeps a mode that was already known', () => {
  const downloading = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.3 }])
  assert.deepEqual(nextAiState(downloading, { type: 'failed' }), { mode: null, stage: null })
  assert.deepEqual(nextAiState({ mode: 'ready', stage: null }, { type: 'failed' }), { mode: 'ready', stage: null })
  assert.deepEqual(nextAiState({ mode: 'simpler', stage: 'simpler' }, { type: 'failed' }), { mode: 'simpler', stage: null })
})

test('it is ready while the notes are still being checked, and the final engine can still correct it', () => {
  const ready = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.99 }, { type: 'engine', engine: 'nano' }])
  assert.equal(ready.mode, 'ready')
  // If Nano then fails while checking, redact() falls back, and the result's engine is what the pill follows.
  assert.equal(nextAiState(ready, { type: 'engine', engine: 'browser-model' }).mode, 'simpler')
})

test('running again after "ready" stays ready until real progress says otherwise', () => {
  const again = run([{ type: 'stage', stage: 'nano' }], { mode: 'ready', stage: null })
  assert.equal(again.mode, 'ready')
})

test('the wording is the wording that was asked for', () => {
  assert.deepEqual(PILL_TEXT, {
    ready: 'Private AI ready',
    downloading: 'Downloading private AI…',
    simpler: 'Simpler checks',
  })
  assert.equal(downloadLabel('nano'), 'Downloading the private AI (first time only)…')
  assert.equal(downloadLabel(null), 'Downloading the private AI (first time only)…')
  for (const text of Object.values(PILL_HELP)) assert.ok(text.length > 20)
})
