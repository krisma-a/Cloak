// Runs pipelines over a case set and builds the report. Pure (no React, no Firebase): the pipelines are
// passed in as plain objects, so tests run in Node with stand-ins and the /eval page passes the real ones.

import { summarizePipeline, type CaseSet, type EvalCase, type EvalReport, type NoteResult, type PipelineOutput } from './score.ts'

export interface Pipeline {
  id: string
  label: string
  /** True only for the pipeline that can refuse a note (retries, then block). Others always let a note through. */
  hasBlocking: boolean
  /** Set when this pipeline cannot run here. It is reported as skipped, never faked. */
  skipped?: string
  run(note: EvalCase): Promise<PipelineOutput>
}

export interface Progress {
  pipeline: string
  /** Notes finished in this pipeline. */
  done: number
  total: number
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'Error'
}

export async function runEval(input: {
  set: CaseSet
  /** How many notes to run, from the start of the set. */
  limit?: number
  pipelines: Pipeline[]
  context?: Record<string, unknown>
  onProgress?: (progress: Progress) => void
  signal?: AbortSignal
  now?: () => Date
}): Promise<EvalReport> {
  const notes = input.set.notes.slice(0, Math.max(1, input.limit ?? input.set.notes.length))
  const summaries = []
  let stopped = false

  for (const pipeline of input.pipelines) {
    const meta = { id: pipeline.id, label: pipeline.label, hasBlocking: pipeline.hasBlocking }
    if (pipeline.skipped !== undefined) {
      summaries.push(summarizePipeline(meta, [], pipeline.skipped))
      continue
    }
    const results: NoteResult[] = []
    for (const note of notes) {
      if (input.signal?.aborted) {
        stopped = true
        break
      }
      try {
        results.push({ note, output: await pipeline.run(note), error: null })
      } catch (e) {
        // Keep the name only: a message could carry text from the note.
        results.push({ note, output: null, error: errorName(e) })
      }
      input.onProgress?.({ pipeline: pipeline.id, done: results.length, total: notes.length })
    }
    summaries.push(summarizePipeline(meta, results))
    if (stopped) break
  }

  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    set: input.set.meta.set,
    seed: input.set.meta.seed,
    notesInSet: input.set.notes.length,
    notesRun: notes.length,
    stopped,
    context: input.context ?? {},
    pipelines: summaries,
  }
}
