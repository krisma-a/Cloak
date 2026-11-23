// Scoring for the /eval page. Pure (no React, no Firebase), so tests run in Node.
//
// Input: a set of FAKE case notes with every planted private item (data/cases/set-b.json, written by
// scripts/generate-cases.ts). Output of one pipeline for one note: the redacted text.
// An item counts as caught when its text no longer appears in that output (the generator's own
// suggestion). Two additions make it stricter and more useful:
//   - a person's name counts as missed if ANY part of it (3+ letters, same capitals) is still visible;
//   - `keep` text (case numbers, event dates...) that disappears is counted as over-redaction.
// Error messages here never repeat the data they were given.

import { CATEGORIES, type Category } from '../ai/placeholders.ts'
import { wholeWordRegex } from '../rules/rules.ts'

export const SCENARIOS = ['investigation', 'accommodation', 'termination'] as const
export type Scenario = (typeof SCENARIOS)[number]

export interface PlantedItem {
  text: string
  type: Category
  entity: string
}

export interface EvalCase {
  id: string
  scenario: Scenario
  style: string
  text: string
  planted: PlantedItem[]
  keep: string[]
  features: string[]
}

export interface CaseSet {
  meta: { set: string; seed: number | null; count: number }
  notes: EvalCase[]
}

// ---------------------------------------------------------------------------------------------
// Loading

function fail(path: string, expected: string): never {
  throw new Error(`Case file is not in the expected shape: ${path} should be ${expected}.`)
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object')
  return value as Record<string, unknown>
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'a list')
  return value
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'text')
  return value
}

function asStrings(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, i) => asString(item, `${path}[${i}]`))
}

function parseNote(raw: unknown, path: string): EvalCase {
  const note = asObject(raw, path)
  const scenario = asString(note.scenario, `${path}.scenario`)
  if (!(SCENARIOS as readonly string[]).includes(scenario)) fail(`${path}.scenario`, 'one of the three case types')
  const planted = asArray(note.planted, `${path}.planted`).map((item, i): PlantedItem => {
    const where = `${path}.planted[${i}]`
    const entry = asObject(item, where)
    const type = asString(entry.type, `${where}.type`)
    if (!(CATEGORIES as readonly string[]).includes(type)) fail(`${where}.type`, 'one of the redaction categories')
    return { text: asString(entry.text, `${where}.text`), type: type as Category, entity: asString(entry.entity, `${where}.entity`) }
  })
  return {
    id: asString(note.id, `${path}.id`),
    scenario: scenario as Scenario,
    style: asString(note.style, `${path}.style`),
    text: asString(note.text, `${path}.text`),
    planted,
    keep: asStrings(note.keep ?? [], `${path}.keep`),
    features: asStrings(note.features ?? [], `${path}.features`),
  }
}

/** Checks the shape of a case file (set-a.json or set-b.json) and returns it typed. */
export function parseCaseSet(json: unknown): CaseSet {
  const root = asObject(json, 'the file')
  const notes = asArray(root.notes, 'notes').map((raw, i) => parseNote(raw, `notes[${i}]`))
  if (notes.length === 0) fail('notes', 'a list with at least one note')
  const meta = typeof root.meta === 'object' && root.meta !== null ? (root.meta as Record<string, unknown>) : {}
  return {
    meta: {
      set: typeof meta.set === 'string' ? meta.set : '?',
      seed: typeof meta.seed === 'number' ? meta.seed : null,
      count: notes.length,
    },
    notes,
  }
}

// ---------------------------------------------------------------------------------------------
// Scoring one note

export type MissReason = 'visible' | 'partial'

export interface ItemResult {
  type: Category
  text: string
  hidden: boolean
  /** "visible": the whole item is still in the output. "partial": one part of a name is. */
  reason?: MissReason
  /** For "partial": the part that is still visible. */
  leftover?: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const present = (text: string, haystack: string): boolean => wholeWordRegex(text).test(haystack)

/** The words of a name worth checking on their own: 3+ letters, outer punctuation trimmed. */
function nameParts(text: string): string[] {
  return text
    .split(/\s+/)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((part) => part.length >= 3)
}

// Same capitals on purpose: a name "Hope" should not be flagged by the ordinary word "hope".
const partVisible = (part: string, output: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, 'u').test(output)

export function scoreCase(note: EvalCase, output: string): { items: ItemResult[]; overRedacted: string[] } {
  const items = note.planted.map((item): ItemResult => {
    if (present(item.text, output)) return { type: item.type, text: item.text, hidden: false, reason: 'visible' }
    if (item.type === 'PERSON') {
      const parts = nameParts(item.text)
      const leftover = parts.length > 1 ? parts.find((part) => partVisible(part, output)) : undefined
      if (leftover !== undefined) return { type: item.type, text: item.text, hidden: false, reason: 'partial', leftover }
    }
    return { type: item.type, text: item.text, hidden: true }
  })
  return { items, overRedacted: note.keep.filter((text) => !present(text, output)) }
}

// ---------------------------------------------------------------------------------------------
// Results of one pipeline over many notes

/** What a pipeline hands back for one note. It times itself, so on-device and cloud time stay apart. */
export interface PipelineOutput {
  /** The redacted text this pipeline would send. */
  text: string
  /** True when the pipeline refused to let this note go (only the full pipeline can). */
  blocked: boolean
  /** Redaction time on this device, in milliseconds. */
  onDeviceMs: number
  /** Time of the cloud draft call, if one was made for this note. */
  cloudMs?: number
  /** True when a cloud call was tried and failed. */
  cloudFailed?: boolean
  engine?: string
  attempts?: number
}

export interface NoteResult {
  note: EvalCase
  /** Null when the pipeline threw for this note. */
  output: PipelineOutput | null
  /** The error name only, never its message. */
  error: string | null
}

export interface Miss {
  noteId: string
  scenario: Scenario
  pipeline: string
  type: Category
  /** The planted item (fake data). */
  text: string
  reason: MissReason
  leftover?: string
  /** The pipeline blocked this note, so the item would not have left the laptop. */
  noteBlocked: boolean
}

export interface CategoryStat {
  type: Category
  planted: number
  caught: number
  rate: number
}

export interface PipelineSummary {
  id: string
  label: string
  /** Why this pipeline did not run (for example, Gemini Nano is not available), or null. */
  skipped: string | null
  hasBlocking: boolean
  notes: number
  scored: number
  failed: number
  planted: number
  caught: number
  catchRate: number | null
  byCategory: CategoryStat[]
  blocked: number
  /** Share of notes blocked. Null when this pipeline has no blocking. */
  blockRate: number | null
  /** Missed items in notes that were NOT blocked: what would really reach the cloud. */
  leakedAfterBlocking: number
  overRedacted: number
  keepTotal: number
  avgOnDeviceMs: number | null
  avgCloudMs: number | null
  cloudSamples: number
  cloudErrors: number
  avgAttempts: number | null
  engines: Record<string, number>
  misses: Miss[]
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)

export function summarizePipeline(
  meta: { id: string; label: string; hasBlocking: boolean },
  results: NoteResult[],
  skipped: string | null = null,
): PipelineSummary {
  const stats = new Map<Category, { planted: number; caught: number }>()
  const misses: Miss[] = []
  const onDevice: number[] = []
  const cloud: number[] = []
  const attempts: number[] = []
  const engines: Record<string, number> = {}
  let planted = 0
  let caught = 0
  let blocked = 0
  let leaked = 0
  let overRedacted = 0
  let keepTotal = 0
  let scored = 0
  let cloudErrors = 0

  for (const { note, output } of results) {
    if (!output) continue
    scored++
    const noteBlocked = meta.hasBlocking && output.blocked
    if (noteBlocked) blocked++
    onDevice.push(output.onDeviceMs)
    if (output.cloudMs !== undefined) cloud.push(output.cloudMs)
    if (output.cloudFailed) cloudErrors++
    if (output.attempts !== undefined) attempts.push(output.attempts)
    if (output.engine) engines[output.engine] = (engines[output.engine] ?? 0) + 1

    const scoredNote = scoreCase(note, output.text)
    overRedacted += scoredNote.overRedacted.length
    keepTotal += note.keep.length
    for (const item of scoredNote.items) {
      const stat = stats.get(item.type) ?? { planted: 0, caught: 0 }
      stat.planted++
      planted++
      if (item.hidden) {
        stat.caught++
        caught++
      } else {
        if (!noteBlocked) leaked++
        misses.push({
          noteId: note.id,
          scenario: note.scenario,
          pipeline: meta.id,
          type: item.type,
          text: item.text,
          reason: item.reason ?? 'visible',
          ...(item.leftover === undefined ? {} : { leftover: item.leftover }),
          noteBlocked,
        })
      }
      stats.set(item.type, stat)
    }
  }

  return {
    id: meta.id,
    label: meta.label,
    skipped,
    hasBlocking: meta.hasBlocking,
    notes: results.length,
    scored,
    failed: results.length - scored,
    planted,
    caught,
    catchRate: ratio(caught, planted),
    byCategory: CATEGORIES.flatMap((type) => {
      const stat = stats.get(type)
      return stat ? [{ type, planted: stat.planted, caught: stat.caught, rate: stat.caught / stat.planted }] : []
    }),
    blocked,
    blockRate: meta.hasBlocking ? ratio(blocked, scored) : null,
    leakedAfterBlocking: leaked,
    overRedacted,
    keepTotal,
    avgOnDeviceMs: mean(onDevice),
    avgCloudMs: mean(cloud),
    cloudSamples: cloud.length,
    cloudErrors,
    avgAttempts: mean(attempts),
    engines,
    misses,
  }
}

export interface EvalReport {
  generatedAt: string
  set: string
  seed: number | null
  notesInSet: number
  notesRun: number
  /** True if the run was stopped early. The numbers cover the notes that finished. */
  stopped: boolean
  /** Anything worth knowing about the run (settings in force, engine used...). Never text. */
  context: Record<string, unknown>
  pipelines: PipelineSummary[]
}
