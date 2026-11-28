// Language check, on this device. Pure: the browser's LanguageDetector is passed in, so `npm test` can use a fake.
//
// Cloak's AI checks (Gemini Nano and the backup name model) are built for English. If a note doesn't look
// English, the note is checked with the basic engine instead and the person is told to review carefully.
// The note's text goes only to the on-device detector. Nothing is stored or sent.

/** The shape of Chrome's LanguageDetector that we use. */
export interface DetectorLike {
  detect(text: string): Promise<ReadonlyArray<{ detectedLanguage: string | null; confidence: number }>>
}

/** English must be this sure, or the note counts as "not English". */
export const MIN_CONFIDENCE = 0.7
/** Fewer letters than this is too little to judge (a name and a date, say), so the check is skipped. */
export const MIN_LETTERS = 20
/** Only the start of the note is looked at: enough to tell, and quick. */
export const SAMPLE_CHARS = 1000

export const NOT_ENGLISH_NOTICE =
  'This note looks like it isn’t in English. Cloak’s AI checks are built for English, so we’ll use Basic checks and you should review carefully.'

export interface LanguageCheck {
  /** The most likely language code, like "es", or "und" when the detector can't say. */
  lang: string
  /** True when no English reading reached MIN_CONFIDENCE. */
  notEnglish: boolean
}

/** A language code that is safe to keep: letters only, like "es" or "zh-Hant". Anything else becomes "und". */
export function safeLanguageCode(code: string | null | undefined): string {
  return typeof code === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(code) ? code : 'und'
}

function isEnglish(code: string | null): boolean {
  return typeof code === 'string' && code.toLowerCase().split('-')[0] === 'en'
}

/**
 * Null means "no opinion": no detector, too little text, or the detector failed. The caller then does nothing
 * differently, and says nothing.
 */
export async function checkLanguage(text: string, detector: DetectorLike | null): Promise<LanguageCheck | null> {
  if (!detector) return null
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters < MIN_LETTERS) return null
  try {
    const results = await detector.detect(text.slice(0, SAMPLE_CHARS))
    if (results.length === 0) return null
    const english = results.some((result) => isEnglish(result.detectedLanguage) && result.confidence >= MIN_CONFIDENCE)
    return { lang: safeLanguageCode(results[0]?.detectedLanguage), notEnglish: !english }
  } catch {
    return null
  }
}
