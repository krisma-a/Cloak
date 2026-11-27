// The browser side of the language check: Chrome's built-in LanguageDetector, if it is there.
// No Firebase and nothing sent anywhere. The logic that uses it is in language.ts.

import type { DetectorLike } from './language.ts'

interface LanguageDetectorApi {
  availability(): Promise<string>
  create(): Promise<DetectorLike>
}

/**
 * The detector, or null. Null whenever there is any doubt: the API isn't in this browser, Chrome would have to
 * download the detector first (that could use up the click that the private AI download needs), or anything throws.
 * The check is then skipped silently.
 */
export async function getLanguageDetector(): Promise<DetectorLike | null> {
  const api = (globalThis as { LanguageDetector?: LanguageDetectorApi }).LanguageDetector
  if (!api) return null
  try {
    if ((await api.availability()) !== 'available') return null
    return await api.create()
  } catch {
    return null
  }
}
