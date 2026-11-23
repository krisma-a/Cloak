// Run with: npm test   (no data involved)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  downloadLabel,
  INITIAL_AI_STATE,
  nextAiState,
  pillHelp,
  PILL_HELP,
  PILL_TEXT,
  SKIP_HINT,
  SKIP_LABEL,
  type AiEvent,
  type AiState,
} from './aiStatus.ts'

const run = (events: AiEvent[], from: AiState = INITIAL_AI_STATE): AiState => events.reduce(nextAiState, from)
const state = (patch: Partial<AiState>): AiState => ({ ...INITIAL_AI_STATE, ...patch })

test('the pill says nothing until the mode is known', () => {
  assert.deepEqual(INITIAL_AI_STATE, { mode: null, stage: null, background: false, nanoReady: false })
  // Nano can run here, but nothing is downloaded or loaded yet: still not known.
  assert.equal(run([{ type: 'stage', stage: 'nano' }]).mode, null)
  assert.equal(pillHelp(INITIAL_AI_STATE), null)
})

test('a first-time Nano download shows "downloading", then "ready" as soon as the engine is ready', () => {
  const states: AiState[] = []
  let current = INITIAL_AI_STATE
  for (const event of [
    { type: 'stage', stage: 'nano' },
    { type: 'progress', fraction: 0.02 },
    { type: 'progress', fraction: 0.6 },
    { type: 'progress', fraction: 1 },
    { type: 'engine', engine: 'nano' }, // prepareRedaction finished: ready, before the notes are even checked
  ] as AiEvent[]) {
    current = nextAiState(current, event)
    states.push(current)
  }
  assert.deepEqual(states.map((s) => s.mode), [null, 'downloading', 'downloading', 'downloading', 'ready'])
  assert.equal(states.at(-1)?.stage, null)
})

test('a model that is already on this laptop never shows "downloading"', () => {
  // Chrome reports no progress when nothing is downloaded, so the events are just stage then engine.
  assert.deepEqual(run([{ type: 'stage', stage: 'nano' }, { type: 'engine', engine: 'nano' }]), state({ mode: 'ready', nanoReady: true }))
  // Progress of exactly 0 or 1 is not "in the middle of a download".
  assert.equal(run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0 }]).mode, null)
  assert.equal(run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 1 }]).mode, null)
  assert.equal(run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: Number.NaN }]).mode, null)
})

test('without Nano it is "basic" straight away, and a download then is not called the private AI', () => {
  const s = run([{ type: 'stage', stage: 'basic' }, { type: 'progress', fraction: 0.4 }])
  assert.deepEqual(s, state({ mode: 'basic', stage: 'basic' }))
  assert.equal(downloadLabel(s.stage), 'Downloading the basic checker (first time only)…')
  assert.equal(run([{ type: 'stage', stage: 'basic' }, { type: 'engine', engine: 'browser-model' }]).mode, 'basic')
  assert.equal(run([{ type: 'engine', engine: 'rules-only' }]).mode, 'basic')
})

test('the engine that really ran decides the final mode, even if Nano failed on the way', () => {
  const s = run([
    { type: 'stage', stage: 'nano' },
    { type: 'progress', fraction: 0.5 },
    { type: 'engine', engine: 'browser-model' }, // Nano broke, so redact() used the backup engine
  ])
  assert.equal(s.mode, 'basic')
  assert.equal(s.nanoReady, false)
})

test('a failure clears "downloading" but keeps a mode that was already known', () => {
  const downloading = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.3 }])
  assert.deepEqual(nextAiState(downloading, { type: 'failed' }), INITIAL_AI_STATE)
  assert.equal(nextAiState(state({ mode: 'ready', nanoReady: true }), { type: 'failed' }).mode, 'ready')
  assert.deepEqual(nextAiState(state({ mode: 'basic', stage: 'basic' }), { type: 'failed' }), state({ mode: 'basic' }))
})

test('it is ready while the notes are still being checked, and the final engine can still correct it', () => {
  const ready = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.99 }, { type: 'engine', engine: 'nano' }])
  assert.equal(ready.mode, 'ready')
  // If Nano then fails while checking, redact() falls back. The pill follows the engine that really ran,
  // unless Nano has already proven itself on this laptop.
  assert.equal(nextAiState(state({ mode: 'ready', stage: 'nano' }), { type: 'engine', engine: 'browser-model' }).mode, 'basic')
})

test('running again after "ready" stays ready until real progress says otherwise', () => {
  const again = run([{ type: 'stage', stage: 'nano' }], state({ mode: 'ready', nanoReady: true }))
  assert.equal(again.mode, 'ready')
})

// ---- "Use basic checks for now" ---------------------------------------------------------------

test('skipping the wait switches to basic checks and remembers the download is still going', () => {
  const downloading = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.2 }])
  assert.equal(downloading.mode, 'downloading')

  const skipped = nextAiState(downloading, { type: 'skip' })
  assert.deepEqual(skipped, state({ mode: 'basic', stage: 'basic', background: true }))
  // Any download from here on is the backup model's, and is labelled that way.
  assert.equal(downloadLabel(skipped.stage), 'Downloading the basic checker (first time only)…')
  // Late progress from the Nano download that is still running does not bring "downloading" back.
  assert.equal(nextAiState(skipped, { type: 'progress', fraction: 0.5 }).mode, 'basic')
  // The basic run finishes: still basic checks, and the download is still in the background.
  const checked = nextAiState(skipped, { type: 'engine', engine: 'browser-model' })
  assert.deepEqual(checked, state({ mode: 'basic', stage: null, background: true }))
  assert.match(pillHelp(checked) ?? '', /still downloading in the background/)
})

test('when the skipped download finishes, the private AI is ready for the next check', () => {
  const checked = run([
    { type: 'stage', stage: 'nano' },
    { type: 'progress', fraction: 0.2 },
    { type: 'skip' },
    { type: 'engine', engine: 'browser-model' },
  ])
  const done = nextAiState(checked, { type: 'background-done', engine: 'nano' })
  assert.deepEqual(done, state({ mode: 'ready', background: false, nanoReady: true }))
  assert.equal(pillHelp(done), PILL_HELP.ready)
})

test('the download can finish while a basic check is still running, and the pill is not pulled back', () => {
  const skipped = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.9 }, { type: 'skip' }])
  const nanoDone = nextAiState(skipped, { type: 'background-done', engine: 'nano' })
  assert.equal(nanoDone.mode, 'ready')
  // The basic check then finishes. It used the backup engine, but the private AI is what is ready now.
  assert.equal(nextAiState(nanoDone, { type: 'engine', engine: 'browser-model' }).mode, 'ready')
})

test('if the skipped download fails, it stays on basic checks and stops saying it is downloading', () => {
  const skipped = run([{ type: 'stage', stage: 'nano' }, { type: 'progress', fraction: 0.4 }, { type: 'skip' }])
  const failed = nextAiState(skipped, { type: 'background-done', engine: 'browser-model' })
  assert.deepEqual(failed, state({ mode: 'basic', stage: 'basic', background: false }))
  assert.equal(pillHelp(failed), PILL_HELP.basic)
})

test('the wording is the wording that was asked for', () => {
  assert.deepEqual(PILL_TEXT, {
    ready: 'Private AI ready',
    downloading: 'Downloading private AI…',
    basic: 'Basic checks',
  })
  assert.equal(downloadLabel('nano'), 'Downloading the private AI (first time only, about 4 GB)…')
  assert.equal(downloadLabel(null), 'Downloading the private AI (first time only, about 4 GB)…')
  assert.equal(SKIP_LABEL, 'Use basic checks for now')
  assert.equal(SKIP_HINT, 'The private AI keeps downloading, and is used next time.')
  for (const text of Object.values(PILL_HELP)) assert.ok(text.length > 20)
})
