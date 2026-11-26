import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEntities } from '../ai/placeholders.ts'
import { matchKey, runBlackout } from './blackoutPlan.ts'
import type { BlackoutParts, Rect } from './blackoutPlan.ts'
import type { OcrResult, OcrWord } from './ocr.ts'
import { countDetails, findSurvivors, mustNotAppear, recheckPhoto } from './recheck.ts'
import type { RecheckParts } from './recheck.ts'

// FAKE DATA ONLY: made-up names and pages. No real OCR: the "reads" are scripted word lists.

const SIZE = { width: 800, height: 400 }

function page(lines: string[][]): OcrResult {
  const words: OcrWord[] = []
  lines.forEach((line, row) => {
    let x = 10
    for (const text of line) {
      const w = text.length * 10
      words.push({ text, x, y: 10 + row * 40, w, h: 20, line: row, confidence: 95 })
      x += w + 10
    }
  })
  return { text: lines.map((line) => line.join(' ')).join('\n'), words }
}

const map = applyEntities('Met Dan Reyes and Priya Okafor. Call 805-555-0163.', [
  { text: 'Dan Reyes', category: 'PERSON' },
  { text: 'Priya Okafor', category: 'PERSON' },
  { text: '805-555-0163', category: 'PHONE' },
]).map

test('the must-not-appear list holds every hidden value and each 3+ letter part of a name, never titles', () => {
  const keys = mustNotAppear(map).map((item) => item.key)
  for (const text of ['Dan Reyes', 'Dan', 'Reyes', 'Priya Okafor', 'Priya', 'Okafor', '805-555-0163']) assert.ok(keys.includes(matchKey(text)), text)
  const withTitle = applyEntities('Dr. Lena Moss', [{ text: 'Dr Lena Moss', category: 'PERSON' }, { text: 'Lena Moss', category: 'PERSON' }]).map
  assert.ok(!mustNotAppear(withTitle).some((item) => item.key === 'dr'))
})

test('survivors are found across split words and with OCR typos, but not in unrelated words (a typo match keeps the first letter)', () => {
  const items = mustNotAppear(map)
  const ocr = page([['Notes', 'for', 'Reyez'], ['Okafr', 'called', '(805)', '555-0163'], ['eyes', 'okay', 'and', 'Danube']])
  const hits = findSurvivors(ocr.words, items)
  const hitWords = new Set(hits.flatMap((hit) => hit.words.map((i) => ocr.words[i]?.text)))
  assert.deepEqual([...hitWords].sort(), ['(805)', '555-0163', 'Okafr', 'Reyez'].sort())
  assert.equal(countDetails(hits), 3)
})

test('one name that survived the blackout gets boxed, the count is 1, and the next read is clean', async () => {
  const reads = [page([['Case', 'notes'], ['Signed', 'Reyes', 'today']]), page([['Case', 'notes'], ['Signed', 'today']])]
  const painted: Rect[][] = []
  const parts: RecheckParts<string> = {
    async read() {
      return reads.shift() ?? page([])
    },
    async paint(canvas, rects) {
      painted.push([...rects])
      return { canvas: `${canvas}+boxes`, blob: new Blob(['png']) }
    },
    size: SIZE,
  }
  const result = await recheckPhoto('copy', mustNotAppear(map), parts)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.fixed, 1)
  assert.equal(result.canvas, 'copy+boxes')
  assert.equal(painted.length, 1)
  const reyes = { x: 80, y: 50, w: 50, h: 20 } // "Reyes" on line 1, after "Signed"
  const box = painted[0]?.[0] as Rect
  assert.ok(box.x <= reyes.x && box.y <= reyes.y && box.x + box.width >= reyes.x + reyes.w && box.y + box.height >= reyes.y + reyes.h)
  assert.equal(result.boxes[0]?.category, 'PERSON')
})

test('a clean copy is read once and nothing is painted', async () => {
  let readsMade = 0
  const result = await recheckPhoto('copy', mustNotAppear(map), {
    async read() {
      readsMade += 1
      return page([['Nothing', 'private', 'here']])
    },
    async paint() {
      throw new Error('should not paint')
    },
    size: SIZE,
  })
  assert.deepEqual(result, { status: 'ok', canvas: 'copy', blob: undefined, fixed: 0, boxes: [] })
  assert.equal(readsMade, 1)
})

test('a detail still readable after 2 rounds of fixes blocks the page', async () => {
  let readsMade = 0
  const result = await recheckPhoto('copy', mustNotAppear(map), {
    async read() {
      readsMade += 1
      return page([['Reyes', 'keeps', 'showing']])
    },
    async paint(canvas) {
      return { canvas, blob: new Blob(['png']) }
    },
    size: SIZE,
  })
  assert.deepEqual(result, { status: 'blocked', fixed: 2, left: 1 })
  assert.equal(readsMade, 3)
})

test('a hit whose word box lies outside the picture blacks out its whole line', async () => {
  const ocr = page([['Signed', 'Reyes']])
  ;(ocr.words[1] as OcrWord).x = 795 // runs off the right edge
  const reads = [ocr, page([])]
  const painted: Rect[][] = []
  const result = await recheckPhoto('copy', mustNotAppear(map), {
    async read() {
      return reads.shift() ?? page([])
    },
    async paint(canvas, rects) {
      painted.push([...rects])
      return { canvas, blob: new Blob(['png']) }
    },
    size: SIZE,
  })
  assert.equal(result.status, 'ok')
  const box = painted[0]?.[0] as Rect
  assert.ok(box.x <= 10 && box.width >= 60, 'covers "Signed" too')
})

test('runBlackout runs the recheck after painting: its boxes are added, the page needs review, a failure blocks', async () => {
  const ocr = page([['Met', 'Dan', 'Reyes', 'today']])
  const parts = (recheck: BlackoutParts<string, string>['recheck']): BlackoutParts<string, string> => ({
    async redact(text) {
      const { text: redactedText, map: m } = applyEntities(text, [{ text: 'Dan Reyes', category: 'PERSON' }])
      return { status: 'ok', redactedText, map: m, leaks: [], engine: 'nano', needsCarefulReview: false }
    },
    async open() {
      return { ...SIZE, paint: async () => ({ blob: new Blob(['first']), canvas: 'first' }) }
    },
    recheck,
  })
  const fixedOne = await runBlackout('page', ocr, parts(async (canvas, m) => {
    assert.equal(canvas, 'first')
    assert.ok(Object.values(m.originals).includes('Dan Reyes'))
    return { status: 'ok', canvas: 'second', blob: new Blob(['second']), fixed: 1, boxes: [{ x: 1, y: 1, width: 5, height: 5, category: 'PERSON' }] }
  }))
  assert.equal(fixedOne.status, 'ok')
  if (fixedOne.status !== 'ok') return
  assert.equal(fixedOne.canvas, 'second')
  assert.deepEqual(fixedOne.recheck, { fixed: 1 })
  assert.equal(fixedOne.boxes.at(-1)?.source, 'recheck')
  assert.equal(fixedOne.needsReview, true)

  const failed = await runBlackout('page', ocr, parts(async () => ({ status: 'blocked', fixed: 2, left: 1 })))
  assert.deepEqual(failed, { status: 'blocked', reason: 'recheck-failed', count: 1, engine: 'nano' })

  const none = await runBlackout('page', ocr, parts(undefined))
  assert.equal(none.status === 'ok' && none.recheck, null)
})
