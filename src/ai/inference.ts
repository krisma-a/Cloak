// One wrapper for every model call, so each one logs where it really ran and what it used.
// Logs only the label and inferenceSource ("on_device" or "in_cloud"), never the prompt or reply.
// Each call also saves a usage record (usage.ts): token counts and the paid-tier price, never any text.

import type { GenerativeModel } from 'firebase/ai'
import { buildUsageEvent, usageOrigin, type UsageEvent, type UsageInput } from './usage.ts'

export interface Generated {
  text: string
  /** Where the SDK says this call ran. "unknown" if the SDK didn't report it. */
  source: string
  /** What the call used and cost (token counts and the paid-tier price; never any text). Null for an unlisted label. */
  usage: UsageEvent | null
}

/** Best effort and never awaited: a usage record that can't be saved never slows or breaks a call. */
async function recordUsage(event: UsageEvent | null): Promise<void> {
  try {
    if (!event) return
    // Loaded on demand, so Firestore stays out of the first page load.
    await (await import('./usageStore.ts')).saveUsageEvent(event)
  } catch (e) {
    console.warn('[usage] not saved:', e instanceof Error ? e.name : 'error')
  }
}

export async function generateLogged(label: string, model: GenerativeModel, prompt: string): Promise<Generated> {
  const result = await model.generateContent(prompt)
  const source = result.response.inferenceSource ?? 'unknown'
  console.info(`[inference] ${label}: ${source}`)
  const text = result.response.text().trim()
  const input: UsageInput = {
    label,
    model: model.model,
    source,
    usage: result.response.usageMetadata ?? null,
    promptChars: prompt.length,
    outputChars: text.length,
    origin: usageOrigin(),
  }
  const usage = buildUsageEvent(input)
  void recordUsage(usage)
  return { text, source, usage }
}
