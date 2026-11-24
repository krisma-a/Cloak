// Generation settings for cloud model calls (drafting, and tagging/tone when they fall back to the cloud).
// Pure (no Firebase), so tests run in Node. Changes how hard the model thinks, never what is sent.

import type { GenerationConfig } from 'firebase/ai'

/**
 * Gemini 3 models think before they answer unless told otherwise. A short HR draft doesn't need that.
 * Measured on 2026-11-24 with gemini-3.6-flash on one fake placeholder note: the default used 1,300 to
 * 2,400 thinking tokens per draft, LOW used none, and every draft kept all its placeholders and invented
 * none. LOW means about 4 times fewer tokens per draft, so the free-tier quota lasts longer.
 * Gemini 2.5 models reject thinkingLevel, so it is only set for Gemini 3.x models; other models get the
 * model's own default.
 */
export function cloudGenerationConfig(model: string): GenerationConfig | undefined {
  return /^gemini-3(?:[.-]|$)/.test(model) ? { thinkingConfig: { thinkingLevel: 'LOW' } } : undefined
}
