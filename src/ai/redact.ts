// On-device redaction. Raw case text NEVER leaves this device, whichever engine runs.
//
// Engines, best first:
//   "nano"          Gemini Nano via Firebase AI Logic (ONLY_ON_DEVICE). Chrome on capable laptops.
//                   Nano finds entities as JSON -> placeholders -> the in-browser name model
//                   cross-checks for names Nano missed -> rules re-check ->
//                   misses go back to Nano (max 2 retries) -> still leaking = blocked.
//   "browser-model" Any browser: a small name/place model running in the page (browserModel.ts)
//                   plus rule and medical-keyword finders (ruleEntities.ts) -> rules re-check.
//   "rules-only"    If the browser model can't load: rule and keyword finders only.
// The non-Nano engines are weaker (they can miss unusual names or medical details), so the
// review step must ask the user to check carefully (see `needsCarefulReview`).

import type { GenerativeModel } from 'firebase/ai'
import { getRedactionModel } from '../firebase'
import { generateLogged } from './inference.ts'
import { findLeaks, type Leak } from '../rules/rules.ts'
import { findNamesAndPlaces, loadBrowserModel } from './browserModel.ts'
import { applyEntities, countByPrefix, emptyMap, sensitiveStrings, type PlaceholderMap } from './placeholders.ts'
import { buildPrompt, ENTITY_SCHEMA, parseEntities } from './redactPrompt.ts'
import { medicalTerms, ruleEntities } from './ruleEntities.ts'

export const MAX_RETRIES = 2 // later read from Remote Config

export type Engine = 'nano' | 'browser-model' | 'rules-only'
export type RedactionStatus = 'ok' | 'blocked'
/**
 * Who checked for names: "model" (Nano or the in-browser name model), "user" (the user listed
 * the names or confirmed there are none), or "unchecked" (rules can't find names; drafting is blocked).
 */
export type NamesCheck = 'model' | 'user' | 'unchecked'

export interface RedactionResult {
  status: RedactionStatus
  engine: Engine
  /** True for the weaker engines: the review screen should ask for a careful check. */
  needsCarefulReview: boolean
  /** Whether names were checked, and by whom. "unchecked" blocks drafting (see guard.ts). */
  names: NamesCheck
  redactedText: string
  map: PlaceholderMap
  /** Leaks still present (empty when status is "ok"). Stays in the browser. */
  leaks: Leak[]
  /** Passes made, including Nano retries. */
  attempts: number
  /** Where it ran: "on_device" (Nano), "in_browser" (browser model) or "rules". */
  ranOn: string
  /** Placeholders per type, e.g. { EMPLOYEE: 2 }. Safe for the audit log. */
  counts: Record<string, number>
  /**
   * Nano engine only: whether the in-browser name model double-checked Nano's work, and how
   * many names/places it hid that Nano missed (a count, safe for the proof page).
   */
  crossCheck?: { ran: boolean; added: number }
  /** Why a better engine was skipped, if one was. */
  note?: string
}

const CROSS_CHECK_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ])
}

// ---------------------------------------------------------------------------------------------
// Gemini Nano engine

// Prompt, JSON schema and reply parsing live in redactPrompt.ts (pure, tested in Node).

let model: GenerativeModel | undefined
function nanoModel(): GenerativeModel {
  model ??= getRedactionModel({ promptOptions: { responseConstraint: ENTITY_SCHEMA } })
  return model
}

// Same options the Firebase SDK passes when it checks availability for our redaction model
// (its defaults: English text + image in, English text out), so both checks agree.
const NANO_CREATE_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
}

/** True if this browser exposes Chrome's built-in model and the device can run it. */
async function nanoSupported(): Promise<boolean> {
  const lm = (globalThis as { LanguageModel?: { availability: (o: object) => Promise<string> } })
    .LanguageModel
  if (!lm) return false
  try {
    return (await lm.availability(NANO_CREATE_OPTIONS)) !== 'unavailable'
  } catch {
    return false
  }
}

async function redactWithNano(text: string, maxRetries: number, knownNames: string[]): Promise<RedactionResult> {
  let map = emptyMap()
  let current = text
  let missed: string[] = []
  let leaks: Leak[] = []
  let attempts = 0
  const crossCheck = { ran: false, added: 0 }

  // Cross-check: the in-browser name model looks for names/places on its own, in parallel.
  // Nano sometimes misses an unusual name, and the rules can't spot names nobody found.
  const namesPromise = withTimeout(findNamesAndPlaces(text), CROSS_CHECK_TIMEOUT_MS).catch(() => null)

  for (let i = 0; i <= maxRetries; i++) {
    attempts++
    const generated = await generateLogged('redact', nanoModel(), buildPrompt(current, missed)) // throws if Nano fails
    ;({ text: current, map } = applyEntities(current, parseEntities(generated.text), map))

    if (i === 0) {
      const names = await namesPromise
      if (names) {
        const before = Object.keys(map.originals).length
        ;({ text: current, map } = applyEntities(current, names, map))
        crossCheck.ran = true
        crossCheck.added = Object.keys(map.originals).length - before
      }
    }

    leaks = findLeaks(current, [...sensitiveStrings(map), ...knownNames])
    if (leaks.length === 0) break
    missed = leaks.map((l) => l.text)
  }

  return {
    status: leaks.length ? 'blocked' : 'ok',
    engine: 'nano',
    needsCarefulReview: false,
    names: 'model',
    redactedText: current,
    map,
    leaks,
    attempts,
    ranOn: 'on_device',
    counts: countByPrefix(map),
    crossCheck,
    note: crossCheck.ran ? undefined : 'name cross-check skipped: in-browser model not available',
  }
}

// ---------------------------------------------------------------------------------------------
// Backup engines (any browser)

async function redactWithoutNano(
  text: string,
  engine: 'browser-model' | 'rules-only',
  knownNames: string[],
): Promise<RedactionResult> {
  const entities = [...ruleEntities(text), ...medicalTerms(text)]
  if (engine === 'browser-model') entities.push(...(await findNamesAndPlaces(text)))

  const { text: redactedText, map } = applyEntities(text, entities)
  const leaks = findLeaks(redactedText, [...sensitiveStrings(map), ...knownNames])
  return {
    status: leaks.length ? 'blocked' : 'ok',
    engine,
    needsCarefulReview: true,
    names: engine === 'browser-model' ? 'model' : 'unchecked',
    redactedText,
    map,
    leaks,
    attempts: 1,
    ranOn: engine === 'browser-model' ? 'in_browser' : 'rules',
    counts: countByPrefix(map),
  }
}

// ---------------------------------------------------------------------------------------------
// Public API

export type EngineChoice = Engine | 'auto'

/**
 * Picks and loads the best engine. Call from a button click (Chrome needs a user action to
 * start the Nano download). `force` is for testing the backup engines on a Nano-capable laptop.
 */
export async function prepareRedaction(
  onProgress?: (fraction: number) => void,
  force: EngineChoice = 'auto',
): Promise<{ engine: Engine; note?: string }> {
  if (force === 'rules-only') return { engine: 'rules-only' }

  let note: string | undefined
  if (force === 'auto' || force === 'nano') {
    if (await nanoSupported()) {
      try {
        await nanoModel().initializeDeviceModel(onProgress)
        // Warm up the cross-check name model in the background (first time: ~109 MB).
        void loadBrowserModel().catch(() => {})
        return { engine: 'nano' }
      } catch (e) {
        note = `Gemini Nano failed to load: ${e instanceof Error ? e.message : String(e)}`
      }
    } else {
      note = 'Gemini Nano is not available in this browser'
    }
  }

  try {
    await loadBrowserModel(onProgress)
    return { engine: 'browser-model', note }
  } catch (e) {
    const why = `browser model failed to load: ${e instanceof Error ? e.message : String(e)}`
    return { engine: 'rules-only', note: note ? `${note}; ${why}` : why }
  }
}

/** Redacts `text` on this device with the given engine (from prepareRedaction). */
export async function redact(
  text: string,
  options: { engine: Engine; maxRetries?: number; knownNames?: string[] },
): Promise<RedactionResult> {
  const knownNames = options.knownNames ?? []
  if (options.engine === 'nano') {
    try {
      return await redactWithNano(text, options.maxRetries ?? MAX_RETRIES, knownNames)
    } catch (e) {
      // Nano broke mid-way: fall back to the backup engine rather than failing.
      const fallback = await redactWithoutNano(text, 'browser-model', knownNames).catch(() =>
        redactWithoutNano(text, 'rules-only', knownNames),
      )
      return { ...fallback, note: `Gemini Nano failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if (options.engine === 'browser-model') {
    return redactWithoutNano(text, 'browser-model', knownNames).catch(async (e) => ({
      ...(await redactWithoutNano(text, 'rules-only', knownNames)),
      note: `browser model failed: ${e instanceof Error ? e.message : String(e)}`,
    }))
  }
  return redactWithoutNano(text, 'rules-only', knownNames)
}
