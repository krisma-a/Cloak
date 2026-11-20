// Backup entity finder for browsers without Gemini Nano (Safari, Firefox, Brave, older laptops).
// Runs a small name/place model INSIDE the browser with transformers.js:
//   Xenova/bert-base-NER (MIT license, ~109 MB quantized), downloaded once and cached.
// Only the model files are downloaded. The case note itself never leaves the device.
// It finds person names and places only; ruleEntities.ts covers IDs, contacts, money,
// "the only ..." phrases and common medical terms.

import type { Entity } from './placeholders.ts'

const MODEL_ID = 'Xenova/bert-base-NER'
const MIN_SCORE = 0.5 // ignore low-confidence guesses

/** One word piece from the model, e.g. { word: '##di', entity: 'B-PER' }. */
export interface NerToken {
  word: string
  score: number
  entity: string // 'O', 'B-PER', 'I-PER', 'B-LOC', ...
  index: number
}
type Ner = (text: string, options: { ignore_labels: string[] }) => Promise<NerToken[]>

let loading: Promise<Ner> | undefined

/** Downloads (first time) and loads the model. `onProgress` gets 0..1 for the main file. */
export function loadBrowserModel(onProgress?: (fraction: number) => void): Promise<Ner> {
  loading ??= (async () => {
    // Loaded on demand so Chrome users with Nano never download this library or model.
    const { pipeline } = await import('@huggingface/transformers')
    const ner = await pipeline('token-classification', MODEL_ID, {
      dtype: 'q8',
      progress_callback: (info: unknown) => {
        const p = info as { status?: string; progress?: number; file?: string }
        if (p.status === 'progress' && typeof p.progress === 'number' && p.file?.endsWith('.onnx')) {
          onProgress?.(p.progress / 100)
        }
      },
    })
    return ner as unknown as Ner
  })()
  loading.catch(() => {
    loading = undefined // let a later click try again
  })
  return loading
}

/**
 * Rebuilds whole words from the model's word pieces and returns names and places.
 * The model tags pieces, not words, and often misses a piece ("Ok" "##af" tagged, "##or" not),
 * so a word counts as a name if ANY of its pieces is tagged as one. Unusual names (Chidi Okafor,
 * Nguyen Thi Lan) come back as fragments otherwise. Person -> PERSON, place -> ADDRESS.
 * Organisations and nationalities stay visible. Pure function, tested in Node.
 */
export function tokensToEntities(tokens: NerToken[]): Entity[] {
  type Kind = 'PER' | 'LOC'
  const words: Array<{ text: string; kind?: Kind; startsEntity: boolean }> = []

  for (const token of [...tokens].sort((a, b) => a.index - b.index)) {
    const kind = token.score >= MIN_SCORE ? (token.entity.slice(2) as string) : ''
    const tagged: Kind | undefined = kind === 'PER' || kind === 'LOC' ? kind : undefined
    const last = words.at(-1)
    if (token.word.startsWith('##') && last) {
      last.text += token.word.slice(2) // continuation piece of the same word
      last.kind ??= tagged
    } else {
      words.push({ text: token.word, kind: tagged, startsEntity: token.entity.startsWith('B-') })
    }
  }

  // Join neighbouring words of the same kind into one span ("Nguyen Thi Lan").
  // A word whose first piece is tagged B- starts a new span.
  const entities: Entity[] = []
  let span: string[] = []
  let spanKind: Kind | undefined
  const flush = () => {
    if (spanKind && span.length) {
      const category = spanKind === 'PER' ? 'PERSON' : 'ADDRESS'
      entities.push({ text: span.join(' '), category })
      // Single words too, in case the note has odd spacing between them.
      if (span.length > 1) for (const w of span) if (w.length >= 3) entities.push({ text: w, category })
    }
    span = []
    spanKind = undefined
  }
  let hyphen = false // a "-" right after a name word: "Jun" "-" "Jun" -> "Jun-Jun"
  for (const word of words) {
    if (word.text === '-' && spanKind) {
      hyphen = true
      continue
    }
    if (hyphen) {
      hyphen = false
      if (word.kind === spanKind) {
        span[span.length - 1] += `-${word.text}`
        continue
      }
      flush()
    }
    if (!word.kind) {
      flush()
    } else if (word.kind !== spanKind || word.startsEntity) {
      flush()
      span = [word.text]
      spanKind = word.kind
    } else {
      span.push(word.text)
    }
  }
  flush()
  return entities
}

/** Person names -> PERSON, places -> ADDRESS, found by the in-browser model. */
export async function findNamesAndPlaces(text: string): Promise<Entity[]> {
  const ner = await loadBrowserModel()
  const tokens = await ner(text, { ignore_labels: [] }) // keep 'O' pieces: they mark word breaks
  return tokensToEntities(tokens)
}
