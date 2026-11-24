// Reads the text in an image on this laptop, with Tesseract.js. Nothing is uploaded: the image goes to a Web
// Worker in this tab, and the worker, the OCR engine and the English data are Cloak's own files (ocrAssets.ts),
// so no request leaves this site. A path that would load from anywhere else is refused before anything starts.
//
// The first read downloads the engine and the English data (about 7 MB) and starts the worker; later reads reuse
// it. The English data is also kept in this browser's IndexedDB (not any case text, just the model), so the next
// visit doesn't download it again. Runs in Node too (the tests do), with local paths.

import { createWorker, OEM } from 'tesseract.js'
import type { ImageLike, LoggerMessage, Worker } from 'tesseract.js'
import { ENG_DATA_VERSION, OCR_DIR } from './ocrAssets.ts'

/** One word and where it is in the image, in pixels from the top-left corner. */
export interface OcrWord {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** Which line the word is on, counting from 0 at the top. */
  line: number
  /** How sure Tesseract is about the word, from 0 to 100. */
  confidence: number
}

export interface OcrResult {
  /** All the text, with a line break between lines. */
  text: string
  /** Every word, in reading order. */
  words: OcrWord[]
}

/** What can be read: a File (from a file picker or camera input), any other Blob, or a canvas. */
export type OcrImage = Blob | HTMLCanvasElement | OffscreenCanvas

export interface OcrProgress {
  /** "loading": getting the engine and English data ready (the first read only). "reading": reading this image. */
  stage: 'loading' | 'reading'
  /** 0 to 1, within the stage. */
  fraction: number
}

export interface OcrCallOptions {
  onProgress?: (progress: OcrProgress) => void
}

/** Where the worker script, the engine folder and the English data folder are. */
export interface OcrPaths {
  workerPath: string
  corePath: string
  langPath: string
}

export interface OcrSettings {
  /** Defaults to Cloak's own files under <base>ocr/. Each must be on this site (in Node: on this computer). */
  paths?: OcrPaths
  /** "write" (the default) keeps the English data in IndexedDB after the first download. "none" never stores it. */
  cacheMethod?: 'write' | 'none'
  /** A stand-in for Tesseract's createWorker, for tests. */
  createWorker?: typeof createWorker
}

export interface OcrReader {
  /** Reads all the text in an image. */
  read(image: OcrImage, options?: OcrCallOptions): Promise<OcrResult>
  /** Starts the engine and loads the English data now, so the first read is quicker. Safe to call again. */
  prepare(options?: OcrCallOptions): Promise<void>
  /** Stops the engine and frees its memory. The next read starts it again. */
  release(): Promise<void>
}

// The IndexedDB key includes the data version, so changing ENG_DATA_VERSION never reuses the old model.
const CACHE_PATH = `cloak-ocr/${ENG_DATA_VERSION}`

// Tesseract's start-up steps, in order. Each counts for a quarter of the "loading" stage.
const LOADING_STEPS = ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api']

/** Turns one of Tesseract's progress messages into an OcrProgress, or null for one we don't report. */
export function toProgress({ status, progress }: Pick<LoggerMessage, 'status' | 'progress'>): OcrProgress | null {
  const part = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  if (status === 'recognizing text') return { stage: 'reading', fraction: part }
  const step = LOADING_STEPS.indexOf(status)
  return step === -1 ? null : { stage: 'loading', fraction: (step + part) / LOADING_STEPS.length }
}

interface BlockLike {
  paragraphs: { lines: { words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[]
}

/** Flattens Tesseract's blocks > paragraphs > lines > words into one list. Lines with no words are not counted. */
export function wordsFromBlocks(blocks: readonly BlockLike[] | null): OcrWord[] {
  const words: OcrWord[] = []
  let line = 0
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const row of paragraph.lines) {
        const before = words.length
        for (const word of row.words) {
          const text = word.text.trim()
          if (text === '') continue
          const { x0, y0, x1, y1 } = word.bbox
          words.push({ text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, line, confidence: word.confidence })
        }
        if (words.length > before) line += 1
      }
    }
  }
  return words
}

/** True when `path` would be fetched from anywhere but this site (in a browser) or this computer (in Node). */
export function isOffDevice(path: string, here: string): boolean {
  const home = new URL(here)
  const target = new URL(path, home)
  return home.protocol === 'file:' ? ['http:', 'https:'].includes(target.protocol) : target.origin !== home.origin
}

/** The image's bytes. A canvas is saved as a PNG first. */
export async function imageBytes(image: OcrImage): Promise<Uint8Array> {
  let blob: Blob | null
  if (image instanceof Blob) {
    blob = image
  } else if (typeof image === 'object' && image !== null && 'convertToBlob' in image) {
    blob = await image.convertToBlob() // OffscreenCanvas
  } else if (typeof image === 'object' && image !== null && 'toBlob' in image) {
    blob = await new Promise<Blob | null>((resolve) => image.toBlob(resolve)) // <canvas>; null when it has no size
  } else {
    throw new TypeError('Only a File, a Blob or a canvas can be read.')
  }
  if (!blob || blob.size === 0) throw new Error('The image is empty, so there is no text to read.')
  return new Uint8Array(await blob.arrayBuffer())
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === 'string' && error !== '' ? error : fallback)
}

function ownPaths(): OcrPaths {
  // import.meta.env only exists under Vite; Node never needs these paths.
  const dir = `${import.meta.env?.BASE_URL ?? '/'}${OCR_DIR}`
  return { workerPath: `${dir}/worker.min.js`, corePath: `${dir}/core`, langPath: `${dir}/lang` }
}

export function createOcrReader(settings: OcrSettings = {}): OcrReader {
  const make = settings.createWorker ?? createWorker
  let engine: Promise<Worker> | null = null
  let listener: ((progress: OcrProgress) => void) | undefined
  let queue: Promise<unknown> = Promise.resolve()

  // One job at a time: the worker reads one image at a time anyway, and this way each job's progress messages
  // go to that job's own callback.
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  async function withProgress<T>(onProgress: OcrCallOptions['onProgress'], job: () => Promise<T>): Promise<T> {
    listener = onProgress
    try {
      return await job()
    } finally {
      listener = undefined
    }
  }

  async function start(): Promise<Worker> {
    const paths = settings.paths ?? ownPaths()
    const here = typeof location === 'undefined' ? 'file:///' : location.href
    for (const [name, path] of Object.entries(paths)) {
      if (isOffDevice(path, here)) throw new Error(`Not loading the OCR ${name} from ${path}: it must come from this site.`)
    }

    // Tesseract reports some start-up failures (a missing language file, for one) only to errorHandler and then
    // never settles createWorker. This turns them into an error instead of an endless wait.
    let started = false
    let failStartup: (reason: unknown) => void = () => undefined
    const startupFailed = new Promise<never>((_, reject) => {
      failStartup = reject
    })

    const worker = await Promise.race([
      make('eng', OEM.LSTM_ONLY, {
        ...paths,
        workerBlobURL: false, // load the worker script directly, not through a blob: URL
        cacheMethod: settings.cacheMethod ?? 'write',
        cachePath: CACHE_PATH,
        logger: (message) => {
          const progress = toProgress(message)
          if (progress) listener?.(progress)
        },
        errorHandler: (error) => {
          if (!started) failStartup(error)
        },
      }),
      startupFailed,
    ])
    started = true
    return worker
  }

  // The worker starts once and is reused. If starting fails, the next call tries again.
  function ready(): Promise<Worker> {
    engine ??= start().catch((error: unknown) => {
      engine = null
      throw toError(error, 'The text reader couldn’t start.')
    })
    return engine
  }

  return {
    read: (image, options = {}) =>
      enqueue(() =>
        withProgress(options.onProgress, async () => {
          const bytes = await imageBytes(image) // before starting the engine, so a bad image fails fast
          const worker = await ready()
          try {
            // Tesseract.js accepts raw image bytes in the browser and in Node, though its types don't list them.
            const { data } = await worker.recognize(bytes as unknown as ImageLike, {}, { text: true, blocks: true })
            options.onProgress?.({ stage: 'reading', fraction: 1 })
            return { text: data.text.trimEnd(), words: wordsFromBlocks(data.blocks) }
          } catch (error) {
            throw toError(error, 'The text reader couldn’t read this image.')
          }
        }),
      ),

    prepare: (options = {}) =>
      enqueue(() =>
        withProgress(options.onProgress, async () => {
          await ready()
        }),
      ),

    release: () =>
      enqueue(async () => {
        const current = engine
        engine = null
        const worker = await current?.catch(() => null)
        await worker?.terminate()
      }),
  }
}

// The reader the app uses: Cloak's own files, one shared worker.
const reader = createOcrReader()

/** Reads all the text in an image on this laptop: the full text, plus every word with its box. */
export const readText = (image: OcrImage, options?: OcrCallOptions): Promise<OcrResult> => reader.read(image, options)

/** Starts the engine and loads the English data ahead of the first read (for example when the camera opens). */
export const prepareOcr = (options?: OcrCallOptions): Promise<void> => reader.prepare(options)

/** Stops the engine and frees its memory (for example when the camera screen closes). */
export const releaseOcr = (): Promise<void> => reader.release()
