import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { applyEntities } from '../ai/placeholders.ts'
import type { Entity } from '../ai/placeholders.ts'
import { categoryOf, detectBoxes, matchKey, ocrText, planBlackout, rememberedInText, runBlackout, unclearWords } from './blackoutPlan.ts'
import type { BlackoutParts, RedactionLike, Rect } from './blackoutPlan.ts'
import type { OcrResult, OcrWord } from './ocr.ts'

// FAKE DATA ONLY: made-up names, IDs and pages.

const SIZE = { width: 800, height: 400 }

/** Lays words out left to right, one row per line, 20 px tall, like a page of OCR output. */
function page(lines: string[][], confidence: (text: string) => number = () => 95): OcrResult {
  const words: OcrWord[] = []
  lines.forEach((line, row) => {
    let x = 10
    for (const text of line) {
      const w = text.length * 10
      words.push({ text, x, y: 10 + row * 40, w, h: 20, line: row, confidence: confidence(text) })
      x += w + 10
    }
  })
  return { text: lines.map((line) => line.join(' ')).join('\n'), words }
}

/** A real placeholder map (applyEntities), as redact() would return it. */
function redaction(text: string, entities: Entity[], status: 'ok' | 'blocked' = 'ok'): RedactionLike {
  const { text: redactedText, map } = applyEntities(text, entities)
  return { status, redactedText, map, leaks: status === 'blocked' ? [{}, {}] : [], engine: 'nano', needsCarefulReview: false }
}

function fakeParts(result: (text: string) => RedactionLike, size = SIZE) {
  const calls = { redact: [] as string[], open: 0, paint: [] as Rect[][] }
  const parts: BlackoutParts<string, string> = {
    async redact(text) {
      calls.redact.push(text)
      return result(text)
    },
    async open() {
      calls.open += 1
      return {
        ...size,
        async paint(rects) {
          calls.paint.push([...rects])
          return { blob: new Blob(['png'], { type: 'image/png' }), canvas: 'canvas-copy' }
        },
      }
    },
  }
  return { parts, calls }
}

const covers = (box: Rect, word: OcrWord) =>
  box.x <= word.x && box.y <= word.y && box.x + box.width >= word.x + word.w && box.y + box.height >= word.y + word.h

test('matchKey folds case, punctuation and OCR look-alikes (0/O, 1/l/I, 5/S)', () => {
  assert.equal(matchKey('J0rdan,'), matchKey('Jordan'))
  assert.equal(matchKey('E-l042'), matchKey('E-1042'))
  assert.equal(matchKey('KELLY'), matchKey('Ke1ly'))
  assert.equal(matchKey('5am'), matchKey('Sam'))
  assert.equal(matchKey('(555) 010-0199'), matchKey('555.010.0199'))
})

test('categoryOf maps placeholder prefixes back to categories', () => {
  assert.equal(categoryOf('[EMPLOYEE_2]'), 'PERSON')
  assert.equal(categoryOf('[MEDICAL_DETAIL_1]'), 'MEDICAL')
  assert.equal(categoryOf('[DEPT_1]'), 'DEPARTMENT')
  assert.equal(categoryOf('[DOB_1]'), 'DATE_OF_BIRTH')
  assert.equal(categoryOf('[ID_3]'), 'OTHER_ID')
  assert.equal(categoryOf('[FAMILY_MEDICAL_1]'), 'FAMILY_MEDICAL')
})

test('a two-word name gets one padded box over both words, and nothing else is covered', async () => {
  const ocr = page([['Met', 'with', 'Jordan', 'Example', 'today']])
  const { parts, calls } = fakeParts((text) => redaction(text, [{ text: 'Jordan Example', category: 'PERSON' }]))
  const result = await runBlackout('page', ocr, parts)

  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.redactedText, 'Met with [EMPLOYEE_1] today')
  assert.equal(result.boxes.length, 1)
  const [box] = result.boxes
  const [, , jordan, example, today] = ocr.words
  assert.ok(box && jordan && example && today)
  assert.equal(box.category, 'PERSON')
  assert.equal(box.source, 'word')
  assert.deepEqual({ x: box.x, y: box.y }, { x: jordan.x - 4, y: jordan.y - 4 })
  assert.equal(box.x + box.width, example.x + example.w + 4)
  assert.ok(!covers(box, today))
  assert.deepEqual(calls.paint, [result.boxes])
  assert.equal(result.needsReview, false)
  assert.equal(result.canvas, 'canvas-copy')
})

test('a name split across a line break gets a box on each line', async () => {
  const ocr = page([['Spoke', 'to', 'Jordan'], ['Example', 'about', 'leave']])
  const { parts } = fakeParts((text) => redaction(text, [{ text: 'Jordan\nExample', category: 'PERSON' }]))
  const result = await runBlackout('page', ocr, parts)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  const [jordan, example] = [ocr.words[2], ocr.words[3]]
  assert.ok(jordan && example)
  assert.ok(result.boxes.some((box) => covers(box, jordan)))
  assert.ok(result.boxes.some((box) => covers(box, example)))
  assert.ok(result.boxes.every((box) => box.height < 40), 'one box per line, not one tall box')
})

test('hyphenated across lines still matches ("Exam-" / "ple")', () => {
  const ocr = page([['Jordan', 'Exam-'], ['ple', 'called']])
  const plan = planBlackout(ocr, { 'jordan example': '[EMPLOYEE_1]' }, SIZE)
  assert.equal(plan.unplaced, 0)
  for (const word of ocr.words.slice(0, 3)) assert.ok(plan.boxes.some((box) => covers(box, word)), word.text)
  assert.ok(!plan.boxes.some((box) => covers(box, ocr.words[3] as OcrWord)))
})

test('OCR typos in the words (0 for O, l for 1) are still matched', () => {
  // The text the redaction saw has the right spelling, but the word boxes were read with look-alikes.
  const ocr = page([['J0rdan', 'Exarnple', 'ID', 'E-l042']])
  ocr.text = 'Jordan Exarnple ID E-1042'
  const plan = planBlackout(ocr, { jordan: '[EMPLOYEE_1]', 'e-1042': '[ID_1]' }, SIZE)
  assert.equal(plan.unplaced, 0)
  assert.ok(plan.boxes.some((b) => b.category === 'PERSON' && covers(b, ocr.words[0] as OcrWord)))
  assert.ok(plan.boxes.some((b) => b.category === 'OTHER_ID' && covers(b, ocr.words[3] as OcrWord)))
})

test('every appearance is covered, including name parts and a name glued to punctuation', () => {
  const ocr = page([['Jordan', 'Example', 'said'], ["Jordan's", 'desk', 'moved']])
  const { map } = applyEntities(ocr.text, [{ text: 'Jordan Example', category: 'PERSON' }])
  const plan = planBlackout(ocr, map.lookup, SIZE)
  assert.ok(plan.boxes.some((box) => covers(box, ocr.words[3] as OcrWord)), "Jordan's is covered")
  assert.ok(!plan.boxes.some((box) => covers(box, ocr.words[4] as OcrWord)))
})

test('a short name inside an unrelated word is not matched ("Lee" in "fleeing")', () => {
  const ocr = page([['Lee', 'was', 'fleeing']])
  const plan = planBlackout(ocr, { lee: '[EMPLOYEE_1]' }, SIZE)
  assert.equal(plan.boxes.length, 1)
  assert.ok(covers(plan.boxes[0] as Rect, ocr.words[0] as OcrWord))
  assert.ok(!covers(plan.boxes[0] as Rect, ocr.words[2] as OcrWord))
})

test('a detail in the text but not in the words blacks out its whole line and asks for review', async () => {
  // The words came out garbled, so "Riley Sample" can't be lined up with them.
  const ocr = page([['Case', 'notes'], ['Rxley', 'Sarnqle', 'called', 'in'], ['Next', 'steps']])
  ocr.text = 'Case notes\nRiley Sample called in\nNext steps'
  const { parts } = fakeParts((text) => redaction(text, [{ text: 'Riley Sample', category: 'PERSON' }]))
  const result = await runBlackout('page', ocr, parts)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.boxes.length, 1)
  assert.equal(result.boxes[0]?.source, 'line')
  for (const word of ocr.words.filter((w) => w.line === 1)) assert.ok(covers(result.boxes[0] as Rect, word), word.text)
  for (const word of ocr.words.filter((w) => w.line !== 1)) assert.ok(!covers(result.boxes[0] as Rect, word), word.text)
  assert.equal(result.needsReview, true)
})

test('a detail that cannot be placed anywhere blocks the page, and nothing is painted', async () => {
  const ocr = page([['Nothing', 'private', 'here']])
  const { parts, calls } = fakeParts(() => ({
    status: 'ok',
    redactedText: 'Nothing private here',
    map: { originals: { '[EMPLOYEE_1]': 'Riley Sample' }, lookup: { 'riley sample': '[EMPLOYEE_1]' } },
    leaks: [],
    engine: 'nano',
    needsCarefulReview: false,
  }))
  const result = await runBlackout('page', ocr, parts)
  assert.deepEqual(result, { status: 'blocked', reason: 'unplaced', count: 1, engine: 'nano' })
  assert.equal(calls.paint.length, 0)
})

test('blocked redaction returns blocked, opens and paints nothing, and returns no text', async () => {
  const ocr = page([['Jordan', 'Example', 'E-1042']])
  const { parts, calls } = fakeParts((text) => redaction(text, [{ text: 'Jordan Example', category: 'PERSON' }], 'blocked'))
  const result = await runBlackout('page', ocr, parts)
  assert.deepEqual(result, { status: 'blocked', reason: 'redaction-blocked', count: 2, engine: 'nano' })
  assert.equal(calls.open, 0)
  assert.equal(calls.paint.length, 0)
  assert.ok(!('redactedText' in result) && !('blob' in result))
})

test('words under 60% confidence are flagged for review (position only), even when nothing is hidden', async () => {
  // 1 unclear word in 8 (12.5%): under the 15% limit, so the page is made and the word is outlined.
  const ocr = page([['Desk', 'move', 'rnaybe', 'next'], ['week', 'once', 'approved', 'today']], (text) =>
    text === 'rnaybe' ? 41 : text === 'approved' ? 60 : 90,
  )
  const { parts, calls } = fakeParts((text) => redaction(text, []))
  const result = await runBlackout('page', ocr, parts)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.boxes.length, 0)
  assert.equal(result.review.length, 1, 'exactly 60 is not flagged')
  assert.ok(covers(result.review[0] as Rect, ocr.words[2] as OcrWord))
  assert.deepEqual(Object.keys(result.review[0] as Rect).sort(), ['height', 'width', 'x', 'y'])
  assert.equal(result.needsReview, true)
  assert.deepEqual(calls.paint, [[]], 'the copy is still made, with no boxes')
})

test('a page where more than 15% of the words are unclear still gets its copy, marked unclear and for review', async () => {
  // A far-away, angled photo: the name came out garbled, so redaction could never find it. 2 of 6 words unclear.
  const ocr = page([['Dear', 'Jcrdcn', 'Exarnp1e'], ['your', 'plan', 'statement']], (text) => (/^(Jcrdcn|Exarnp1e)$/.test(text) ? 35 : 92))
  const { parts, calls } = fakeParts((text) => redaction(text, []))
  const result = await runBlackout('page', ocr, parts)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.unclear, true)
  assert.equal(result.needsReview, true)
  assert.equal(result.review.length, 2)
  assert.equal(calls.paint.length, 1, 'the copy is made so the person can see what was captured')
})

test('a clear page is not marked unclear', async () => {
  const { parts } = fakeParts((text) => redaction(text, []))
  const result = await runBlackout('page', page([['All', 'clear', 'here']]), parts)
  assert.equal(result.status === 'ok' && result.unclear, false)
})

test('the unclear-word limit can be changed, and a page with no words counts as unreadable', () => {
  assert.deepEqual(unclearWords([]), { count: 0, share: 1 })
  const words = page([['a', 'b', 'c', 'd']], (t) => (t === 'a' ? 10 : 90)).words
  assert.deepEqual(unclearWords(words), { count: 1, share: 0.25 })
  assert.deepEqual(unclearWords(words, 5), { count: 0, share: 0 })
})

test('OCR boxes that do not fit the image block the page (they would land in the wrong place)', async () => {
  const ocr = page([['Jordan', 'Example']])
  const { parts, calls } = fakeParts((text) => redaction(text, [{ text: 'Jordan', category: 'PERSON' }]), { width: 50, height: 400 })
  const result = await runBlackout('page', ocr, parts)
  assert.equal(result.status, 'blocked')
  assert.equal(result.status === 'blocked' && result.reason, 'image-mismatch')
  assert.equal(calls.paint.length, 0)
})

test('an email OCR split at the @ is still redacted and covered ("jordan.example @example.com")', async () => {
  const ocr = page([['Email', 'jordan.example', '@example.com', 'today']])
  assert.equal(ocrText(ocr), 'Email jordan.example@example.com today')
  const { parts, calls } = fakeParts((text) => {
    const email = text.match(/\S+@\S+/)?.[0] ?? ''
    return redaction(text, email ? [{ text: email, category: 'EMAIL' }] : [])
  })
  const result = await runBlackout('page', ocr, parts)
  assert.equal(calls.redact[0], 'Email jordan.example@example.com today')
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.redactedText, 'Email [EMAIL_1] today')
  assert.equal(result.boxes.length, 1)
  for (const word of ocr.words.slice(1, 3)) assert.ok(covers(result.boxes[0] as Rect, word), word.text)
  assert.ok(!covers(result.boxes[0] as Rect, ocr.words[3] as OcrWord))
})

test('padding is clamped to the image edges', () => {
  const ocr: OcrResult = { text: 'Jordan', words: [{ text: 'Jordan', x: 1, y: 2, w: 60, h: 20, line: 0, confidence: 90 }] }
  const plan = planBlackout(ocr, { jordan: '[EMPLOYEE_1]' }, { width: 63, height: 24 }, { padding: 6 })
  assert.deepEqual(plan.boxes, [{ x: 0, y: 0, width: 63, height: 24, category: 'PERSON', source: 'word' }])
})

test('boxes carry a position, a category and how they were placed, never the hidden text', async () => {
  const ocr = page([['Jordan', 'Example', 'has', 'asthma']])
  const { parts } = fakeParts((text) =>
    redaction(text, [
      { text: 'Jordan Example', category: 'PERSON' },
      { text: 'asthma', category: 'MEDICAL' },
    ]),
  )
  const result = await runBlackout('page', ocr, parts)
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.deepEqual(result.boxes.map((b) => b.category).sort(), ['MEDICAL', 'PERSON'])
  const json = JSON.stringify({ boxes: result.boxes, review: result.review })
  for (const secret of ['Jordan', 'Example', 'asthma']) assert.ok(!json.includes(secret), secret)
  assert.ok(result.boxes.every((b) => Object.keys(b).sort().join() === 'category,height,source,width,x,y'))
  assert.equal(result.redactedText, '[EMPLOYEE_1] has [MEDICAL_DETAIL_1]')
})

test('the blackout code never sends anything: no network calls and no cloud drafting in either file', async () => {
  for (const file of ['./blackout.ts', './blackoutPlan.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', '/draft', 'firebase', 'getDraftingModel']) {
      assert.ok(!code.includes(banned), `${file} mentions ${banned}`)
    }
  }
})

test('detectBoxes finds the same boxes as the photo would get, and paints nothing', async () => {
  const ocr = page([['Met', 'with', 'Jordan', 'Example', 'today']])
  const redact = async (text: string) => redaction(text, [{ text: 'Jordan Example', category: 'PERSON' }])
  const found = await detectBoxes(ocr, SIZE, redact)
  const { parts } = fakeParts(redact)
  const photo = await runBlackout('page', ocr, parts)
  assert.equal(found.status, 'ok')
  assert.equal(photo.status, 'ok')
  if (found.status === 'ok' && photo.status === 'ok') assert.deepEqual(found.boxes, photo.boxes)
})

test('detectBoxes says hard-to-read without redacting, and blocked when a detail cannot be placed', async () => {
  let redacted = 0
  const garbled = page([['Dear', 'Jcrdcn', 'Exarnp1e']], (t) => (t === 'Dear' ? 90 : 30))
  const unclear = await detectBoxes(garbled, SIZE, async (text) => {
    redacted += 1
    return redaction(text, [])
  })
  assert.deepEqual(unclear, { status: 'hard-to-read' })
  assert.equal(redacted, 0)

  const blocked = await detectBoxes(page([['Hello']]), SIZE, async () => ({
    status: 'ok',
    redactedText: 'Hello',
    map: { originals: { '[EMPLOYEE_1]': 'Riley Sample' }, lookup: { 'riley sample': '[EMPLOYEE_1]' } },
    leaks: [],
    engine: 'browser-model',
    needsCarefulReview: true,
  }))
  assert.deepEqual(blocked, { status: 'blocked' })
})

test('rememberedInText keeps only the remembered names that are on this frame, with OCR look-alikes', () => {
  const remembered = { 'riley sample': '[EMPLOYEE_1]', 'jordan': '[EMPLOYEE_2]', 'al': '[EMPLOYEE_3]' }
  assert.deepEqual(rememberedInText(remembered, 'R1ley Sample will call.\nAl said hi'), { 'riley sample': '[EMPLOYEE_1]' })
  assert.deepEqual(rememberedInText(remembered, 'Nothing here'), {})
})
