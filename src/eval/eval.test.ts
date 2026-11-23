// Run with: npm test   (fake data only: Set B is synthetic, and the notes below are made up)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyEntities } from '../ai/placeholders.ts'
import { medicalTerms, ruleEntities } from '../ai/ruleEntities.ts'
import { runEval, type Pipeline } from './runner.ts'
import {
  parseCaseSet,
  scoreCase,
  summarizePipeline,
  type CaseSet,
  type EvalCase,
  type NoteResult,
  type PipelineOutput,
} from './score.ts'

const setB = parseCaseSet(JSON.parse(readFileSync(new URL('../../data/cases/set-b.json', import.meta.url), 'utf8')))

function note(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'T1',
    scenario: 'investigation',
    style: 'prose',
    text: 'Case 9-1. Pat Rivers wrote to pat@example.com about the Reno depot.',
    planted: [
      { text: 'Pat Rivers', type: 'PERSON', entity: 'person:1' },
      { text: 'pat@example.com', type: 'EMAIL', entity: 'email:1' },
    ],
    keep: ['Case 9-1'],
    features: [],
    ...overrides,
  }
}

const out = (text: string, extra: Partial<PipelineOutput> = {}): PipelineOutput => ({
  text,
  blocked: false,
  onDeviceMs: 10,
  ...extra,
})

test('Set B loads and has every planted item typed with a real category', () => {
  assert.equal(setB.meta.set, 'B')
  assert.equal(setB.notes.length, 60)
  assert.ok(setB.notes.every((n) => n.planted.length > 0 && n.text.length > 0))
  const types = new Set(setB.notes.flatMap((n) => n.planted.map((p) => p.type)))
  for (const type of ['PERSON', 'EMAIL', 'PHONE', 'SALARY', 'MEDICAL', 'ROLE', 'ADDRESS']) assert.ok(types.has(type as never))
})

test('a case file in the wrong shape is refused, and the message never repeats its text', () => {
  assert.throws(() => parseCaseSet(null), /expected shape/)
  assert.throws(() => parseCaseSet({ notes: [] }), /at least one note/)
  const secret = 'Zorblax Quillfeather'
  const bad = { notes: [{ ...note(), text: secret, scenario: 'party', planted: [] }] }
  assert.throws(
    () => parseCaseSet(bad),
    (error: Error) => /scenario/.test(error.message) && !error.message.includes(secret) && !error.message.includes('party'),
  )
  assert.throws(() => parseCaseSet({ notes: [{ ...note(), planted: [{ text: 'x', type: 'NOPE', entity: 'e' }] }] }), /redaction categories/)
})

test('an item is caught when its text is gone, whatever the capitals', () => {
  const n = note()
  assert.deepEqual(scoreCase(n, 'Case 9-1. [EMPLOYEE_1] wrote to [EMAIL_1] about the Reno depot.').items.map((i) => i.hidden), [true, true])

  const leaked = scoreCase(n, 'Case 9-1. [EMPLOYEE_1] wrote to PAT@EXAMPLE.COM about the Reno depot.')
  assert.deepEqual(leaked.items.map((i) => [i.type, i.hidden, i.reason]), [
    ['PERSON', true, undefined],
    ['EMAIL', false, 'visible'],
  ])
})

test('a name with one part still showing is a miss, and the part is named', () => {
  const partial = scoreCase(note(), 'Case 9-1. [EMPLOYEE_1] Rivers wrote to [EMAIL_1].').items[0]
  assert.deepEqual(partial, { type: 'PERSON', text: 'Pat Rivers', hidden: false, reason: 'partial', leftover: 'Rivers' })

  // The part must match the name's own capitals: the word "rivers" is not the surname "Rivers".
  const ordinary = scoreCase(note(), 'Case 9-1. [EMPLOYEE_1] walked by the rivers near [EMAIL_1].').items[0]
  assert.equal(ordinary.hidden, true)
  // One-word names are checked once, as a whole word.
  const single = scoreCase(note({ planted: [{ text: 'Ada', type: 'PERSON', entity: 'p' }] }), 'Ada was late.')
  assert.equal(single.items[0].reason, 'visible')
})

test('text that should stay visible is counted when it disappears', () => {
  assert.deepEqual(scoreCase(note(), 'Case 9-1. x').overRedacted, [])
  assert.deepEqual(scoreCase(note(), '[ID_1]. x').overRedacted, ['Case 9-1'])
})

test('a summary keeps catch rates per category, block rate, leaks after blocking, and timings', () => {
  const a = note({ id: 'A' })
  const b = note({ id: 'B' })
  const c = note({ id: 'C' })
  const results: NoteResult[] = [
    // A: everything hidden
    { note: a, output: out('[EMPLOYEE_1] [EMAIL_1] Case 9-1', { onDeviceMs: 100, cloudMs: 2000, engine: 'nano', attempts: 1 }), error: null },
    // B: email left visible, and the note was blocked, so it would not be sent
    { note: b, output: out('[EMPLOYEE_1] pat@example.com Case 9-1', { blocked: true, onDeviceMs: 300, engine: 'nano', attempts: 3 }), error: null },
    // C: the pipeline threw
    { note: c, output: null, error: 'Error' },
  ]
  const s = summarizePipeline({ id: 'full', label: 'Full', hasBlocking: true }, results)

  assert.equal(s.notes, 3)
  assert.equal(s.scored, 2)
  assert.equal(s.failed, 1)
  assert.equal(s.planted, 4)
  assert.equal(s.caught, 3)
  assert.equal(s.catchRate, 0.75)
  assert.deepEqual(s.byCategory.map((x) => [x.type, x.planted, x.caught, x.rate]), [
    ['PERSON', 2, 2, 1],
    ['EMAIL', 2, 1, 0.5],
  ])
  assert.equal(s.blocked, 1)
  assert.equal(s.blockRate, 0.5)
  assert.equal(s.leakedAfterBlocking, 0, 'the one miss was in a blocked note')
  assert.deepEqual(s.misses.map((m) => [m.noteId, m.type, m.reason, m.noteBlocked]), [['B', 'EMAIL', 'visible', true]])
  assert.equal(s.avgOnDeviceMs, 200)
  assert.equal(s.avgCloudMs, 2000, 'cloud time averages only the notes that were timed')
  assert.equal(s.cloudSamples, 1)
  assert.equal(s.avgAttempts, 2)
  assert.deepEqual(s.engines, { nano: 2 })
})

test('a pipeline with no blocking reports no block rate, and every miss counts as a leak', () => {
  const s = summarizePipeline({ id: 'regex', label: 'Regex', hasBlocking: false }, [
    { note: note(), output: out('Pat Rivers pat@example.com Case 9-1', { blocked: true }), error: null },
  ])
  assert.equal(s.blockRate, null)
  assert.equal(s.blocked, 0)
  assert.equal(s.leakedAfterBlocking, 2)
  assert.equal(s.catchRate, 0)
})

test('an empty result gives null rates, not zero or NaN', () => {
  const s = summarizePipeline({ id: 'x', label: 'X', hasBlocking: true }, [], 'Gemini Nano is not available')
  assert.equal(s.skipped, 'Gemini Nano is not available')
  assert.equal(s.catchRate, null)
  assert.equal(s.blockRate, null)
  assert.equal(s.avgOnDeviceMs, null)
  assert.equal(s.avgCloudMs, null)
  assert.deepEqual(s.byCategory, [])
})

function fake(id: string, run: Pipeline['run'], extra: Partial<Pipeline> = {}): Pipeline {
  return { id, label: id, hasBlocking: false, run, ...extra }
}

test('the runner limits notes, skips what cannot run, and records errors by name only', async () => {
  const set: CaseSet = { meta: { set: 'T', seed: 1, count: 3 }, notes: [note({ id: '1' }), note({ id: '2' }), note({ id: '3' })] }
  const progress: string[] = []
  const report = await runEval({
    set,
    limit: 2,
    pipelines: [
      fake('ok', async (n) => out(n.text.replaceAll('Pat Rivers', 'X'))),
      fake('broken', async () => {
        throw new TypeError('the note said Pat Rivers')
      }),
      fake('missing', async () => out(''), { skipped: 'Gemini Nano is not available' }),
    ],
    context: { engine: 'test' },
    onProgress: (p) => progress.push(`${p.pipeline}:${p.done}/${p.total}`),
    now: () => new Date('2026-11-23T10:00:00Z'),
  })

  assert.equal(report.generatedAt, '2026-11-23T10:00:00.000Z')
  assert.equal(report.notesRun, 2)
  assert.equal(report.notesInSet, 3)
  assert.equal(report.stopped, false)
  assert.deepEqual(report.context, { engine: 'test' })
  assert.deepEqual(progress, ['ok:1/2', 'ok:2/2', 'broken:1/2', 'broken:2/2'])
  const [ok, broken, missing] = report.pipelines
  assert.equal(ok.scored, 2)
  assert.equal(broken.failed, 2)
  assert.equal(missing.skipped, 'Gemini Nano is not available')
  // Nothing in the report holds the error message, so nothing from a note can leak through it.
  assert.ok(!JSON.stringify(report).includes('the note said'))
})

test('stopping early gives a report for the notes that finished', async () => {
  const controller = new AbortController()
  const set: CaseSet = { meta: { set: 'T', seed: null, count: 4 }, notes: [1, 2, 3, 4].map((i) => note({ id: String(i) })) }
  let calls = 0
  const report = await runEval({
    set,
    pipelines: [fake('p', async (n) => { if (++calls === 2) controller.abort(); return out(n.text) })],
    signal: controller.signal,
  })
  assert.equal(report.stopped, true)
  assert.equal(report.pipelines[0].scored, 2)
})

test('regex only, run on all of Set B, finds fixed-shape details but cannot find names', () => {
  const run = () =>
    setB.notes.map((n): NoteResult => {
      const { text } = applyEntities(n.text, [...ruleEntities(n.text), ...medicalTerms(n.text)])
      return { note: n, output: out(text), error: null }
    })
  const meta = { id: 'regex', label: 'Regex only', hasBlocking: false }
  const s = summarizePipeline(meta, run())

  assert.equal(s.planted, setB.notes.reduce((sum, n) => sum + n.planted.length, 0))
  assert.deepEqual(summarizePipeline(meta, run()).byCategory, s.byCategory, 'same input, same numbers')
  const rate = (type: string) => s.byCategory.find((c) => c.type === type)?.rate ?? NaN
  assert.equal(rate('EMAIL'), 1)
  assert.ok(rate('PERSON') < 0.1, 'rules cannot recognise names')
  assert.ok((s.catchRate ?? 1) < 0.5, 'which is why the on-device model is needed')
  assert.equal(s.misses.length, s.planted - s.caught)
})
