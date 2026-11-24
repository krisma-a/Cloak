import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { createWorker } from 'tesseract.js'
import { createOcrReader, imageBytes, isOffDevice, toProgress, wordsFromBlocks } from './ocr.ts'
import type { OcrProgress, OcrWord } from './ocr.ts'
import { OCR_FILES } from './ocrAssets.ts'

// The sample is a made-up two-line note, 720 x 160, drawn by scripts/make-ocr-sample.swift. FAKE DATA ONLY.
const SAMPLE = new URL('./fixtures/ocr-sample.png', import.meta.url)
const SAMPLE_SIZE = { width: 720, height: 160 }
const EXPECTED_LINES = ['Sample note for Cloak', 'Jordan Example needs a quiet desk.']

// In Node everything comes from node_modules on this computer: the worker script, the engine and the English data.
const fromTesseract = createRequire(createRequire(import.meta.url).resolve('tesseract.js/package.json'))
const langFile = OCR_FILES.find((file) => file.path.startsWith('lang/'))?.from ?? ''
const NODE_PATHS = {
  workerPath: fromTesseract.resolve('./src/worker-script/node/index.js'),
  corePath: dirname(fromTesseract.resolve('tesseract.js-core/package.json')),
  langPath: dirname(fromTesseract.resolve(langFile)),
}

function lineTexts(words: OcrWord[]): string[] {
  const lines: string[][] = []
  for (const word of words) (lines[word.line] ??= []).push(word.text)
  return lines.map((line) => line.join(' '))
}

test('reads the sample image on this computer: the full text, every word with its box, and progress', async (t) => {
  let created = 0
  const reader = createOcrReader({
    paths: NODE_PATHS,
    cacheMethod: 'none', // in Node, "write" would save eng.traineddata into the working folder
    createWorker: (...args) => {
      created += 1
      return createWorker(...args)
    },
  })
  t.after(() => reader.release()) // or the worker thread keeps the test run alive

  // The image never goes to fetch: any fetch on this thread fails the test. (The worker thread reads the English
  // data from disk, because langPath is a folder on this computer.)
  const realFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('fetch was called during OCR')
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  const png = await readFile(SAMPLE)
  const progress: OcrProgress[] = []
  const first = await reader.read(new File([png], 'ocr-sample.png', { type: 'image/png' }), {
    onProgress: (p) => progress.push(p),
  })

  assert.equal(first.text, EXPECTED_LINES.join('\n'))
  assert.deepEqual(lineTexts(first.words), EXPECTED_LINES)
  for (const word of first.words) {
    assert.ok(word.w > 0 && word.h > 0, `${word.text} has a size`)
    assert.ok(word.x >= 0 && word.y >= 0, `${word.text} starts inside the image`)
    assert.ok(word.x + word.w <= SAMPLE_SIZE.width && word.y + word.h <= SAMPLE_SIZE.height, `${word.text} ends inside the image`)
    assert.ok(word.confidence > 50 && word.confidence <= 100, `${word.text} was read with confidence (${word.confidence})`)
  }
  // The boxes are where the words are: the first line sits above the second, and words run left to right.
  const line0 = first.words.filter((word) => word.line === 0)
  const line1 = first.words.filter((word) => word.line === 1)
  assert.ok(Math.max(...line0.map((w) => w.y + w.h)) <= Math.min(...line1.map((w) => w.y)))
  for (let i = 1; i < line0.length; i += 1) assert.ok((line0[i]?.x ?? 0) > (line0[i - 1]?.x ?? 0))

  // Progress: the one-time loading first, then reading, finishing at reading 1, never going backwards.
  assert.equal(progress[0]?.stage, 'loading')
  assert.deepEqual(progress.at(-1), { stage: 'reading', fraction: 1 })
  const firstReading = progress.findIndex((p) => p.stage === 'reading')
  assert.ok(progress.slice(firstReading).every((p) => p.stage === 'reading'))
  for (let i = 1; i < progress.length; i += 1) {
    const [before, now] = [progress[i - 1], progress[i]]
    if (before && now && before.stage === now.stage) assert.ok(now.fraction >= before.fraction)
  }

  // A second read (a Blob this time) reuses the worker and its English data: nothing loads again.
  const again: OcrProgress[] = []
  const second = await reader.read(new Blob([png], { type: 'image/png' }), { onProgress: (p) => again.push(p) })
  assert.equal(second.text, first.text)
  assert.equal(created, 1)
  assert.ok(again.length > 0 && again.every((p) => p.stage === 'reading'))
})

test('refuses to load the engine or its data from another site, before starting anything', async () => {
  let created = 0
  const reader = createOcrReader({
    paths: { ...NODE_PATHS, langPath: 'https://tessdata.projectnaptha.com/4.0.0' },
    createWorker: (...args) => {
      created += 1
      return createWorker(...args)
    },
  })
  await assert.rejects(reader.read(new Blob([await readFile(SAMPLE)])), /must come from this site/)
  assert.equal(created, 0)
})

test('isOffDevice: only this site in a browser, and only this computer in Node', () => {
  const site = 'http://localhost:5173/'
  assert.equal(isOffDevice('/ocr/worker.min.js', site), false)
  assert.equal(isOffDevice('http://localhost:5173/ocr/core', site), false)
  assert.equal(isOffDevice('https://cdn.jsdelivr.net/npm/tesseract.js@v7.0.0/dist/worker.min.js', site), true)
  assert.equal(isOffDevice('//cdn.example.com/ocr/lang', site), true)
  assert.equal(isOffDevice('http://localhost:9999/ocr/lang', site), true) // another port is another site
  assert.equal(isOffDevice(NODE_PATHS.langPath, 'file:///'), false)
  assert.equal(isOffDevice('https://tessdata.projectnaptha.com/4.0.0', 'file:///'), true)
})

test('toProgress maps Tesseract’s start-up steps to "loading" and recognition to "reading"', () => {
  assert.deepEqual(toProgress({ status: 'loading tesseract core', progress: 0 }), { stage: 'loading', fraction: 0 })
  assert.deepEqual(toProgress({ status: 'loading language traineddata', progress: 0.5 }), { stage: 'loading', fraction: 0.625 })
  assert.deepEqual(toProgress({ status: 'initializing api', progress: 1 }), { stage: 'loading', fraction: 1 })
  assert.deepEqual(toProgress({ status: 'recognizing text', progress: 0.42 }), { stage: 'reading', fraction: 0.42 })
  assert.deepEqual(toProgress({ status: 'recognizing text', progress: 1.7 }), { stage: 'reading', fraction: 1 })
  assert.equal(toProgress({ status: 'something new', progress: 0.5 }), null)
})

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 })

test('wordsFromBlocks flattens the layout into words with x, y, w, h, a line number and a confidence', () => {
  const blocks = [
    {
      paragraphs: [
        {
          lines: [
            { words: [{ text: 'Hello', confidence: 91.5, bbox: box(10, 20, 60, 40) }, { text: 'world', confidence: 88, bbox: box(70, 21, 130, 40) }] },
            { words: [{ text: '  ', confidence: 0, bbox: box(0, 0, 1, 1) }] }, // nothing to read: not a line
          ],
        },
        { lines: [{ words: [{ text: 'Again', confidence: 95, bbox: box(10, 60, 70, 80) }] }] },
      ],
    },
  ]
  assert.deepEqual(wordsFromBlocks(blocks), [
    { text: 'Hello', x: 10, y: 20, w: 50, h: 20, line: 0, confidence: 91.5 },
    { text: 'world', x: 70, y: 21, w: 60, h: 19, line: 0, confidence: 88 },
    { text: 'Again', x: 10, y: 60, w: 60, h: 20, line: 1, confidence: 95 },
  ])
  assert.deepEqual(wordsFromBlocks(null), [])
})

test('imageBytes takes a File, a Blob, a canvas or an offscreen canvas, and refuses an empty image', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
  const blob = new Blob([bytes], { type: 'image/png' })
  const canvas = { toBlob: (done: (b: Blob | null) => void) => done(blob) } as unknown as HTMLCanvasElement
  const offscreen = { convertToBlob: async () => blob } as unknown as OffscreenCanvas

  for (const image of [blob, new File([bytes], 'scan.png'), canvas, offscreen]) {
    assert.deepEqual(await imageBytes(image), bytes)
  }
  await assert.rejects(imageBytes(new Blob([])), /empty/)
  const noSize = { toBlob: (done: (b: Blob | null) => void) => done(null) } as unknown as HTMLCanvasElement
  await assert.rejects(imageBytes(noSize), /empty/)
  await assert.rejects(imageBytes('photo.png' as unknown as Blob), TypeError)
})

// A stand-in for Tesseract that answers at once, so the reader's own logic can be tested quickly.
function fakeTesseract(options: { failFirstStart?: boolean } = {}) {
  const calls = { created: 0, recognized: 0, terminated: 0 }
  const make = (async (_langs: unknown, _oem: unknown, settings: { logger: (m: object) => void; errorHandler: (e: unknown) => void }) => {
    calls.created += 1
    if (options.failFirstStart && calls.created === 1) {
      // What Tesseract does when the language file is missing: errorHandler is told, createWorker never settles.
      setTimeout(() => settings.errorHandler('Error: ENOENT: no such file, eng.traineddata.gz'), 0)
      return new Promise(() => undefined)
    }
    settings.logger({ status: 'loading tesseract core', progress: 0 })
    settings.logger({ status: 'initializing api', progress: 1 })
    return {
      recognize: async () => {
        calls.recognized += 1
        settings.logger({ status: 'recognizing text', progress: 0.5 })
        return { data: { text: 'Hi there\n', blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Hi', confidence: 90, bbox: box(0, 0, 10, 10) }] }] }] }] } }
      },
      terminate: async () => {
        calls.terminated += 1
      },
    }
  }) as unknown as typeof createWorker
  return { calls, make }
}

const tinyImage = () => new Blob([new Uint8Array([1, 2, 3])])

test('starts the engine once, even for reads made at the same time, and gives each read its own progress', async () => {
  const fake = fakeTesseract()
  const reader = createOcrReader({ paths: NODE_PATHS, createWorker: fake.make })
  const seen: OcrProgress[][] = [[], [], []]
  const results = await Promise.all(seen.map((log) => reader.read(tinyImage(), { onProgress: (p) => log.push(p) })))

  assert.equal(fake.calls.created, 1)
  assert.equal(fake.calls.recognized, 3)
  assert.deepEqual(results[0], { text: 'Hi there', words: [{ text: 'Hi', x: 0, y: 0, w: 10, h: 10, line: 0, confidence: 90 }] })
  assert.equal(seen[0]?.[0]?.stage, 'loading') // only the read that started the engine saw it load
  for (const log of seen.slice(1)) {
    assert.deepEqual(log, [{ stage: 'reading', fraction: 0.5 }, { stage: 'reading', fraction: 1 }])
  }
})

test('a start-up failure Tesseract only reports to errorHandler is an error, not an endless wait, and the next read retries', async () => {
  const fake = fakeTesseract({ failFirstStart: true })
  const reader = createOcrReader({ paths: NODE_PATHS, createWorker: fake.make })
  await assert.rejects(reader.read(tinyImage()), /ENOENT/)
  assert.equal((await reader.read(tinyImage())).text, 'Hi there')
  assert.equal(fake.calls.created, 2)
})

test('a bad image fails before the engine starts, and release stops the engine so the next read starts a new one', async () => {
  const fake = fakeTesseract()
  const reader = createOcrReader({ paths: NODE_PATHS, createWorker: fake.make })
  await assert.rejects(reader.read(new Blob([])), /empty/)
  assert.equal(fake.calls.created, 0)

  await reader.read(tinyImage())
  await reader.release()
  assert.equal(fake.calls.terminated, 1)
  await reader.read(tinyImage())
  assert.equal(fake.calls.created, 2)
})
