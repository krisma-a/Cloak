// Helpers for "Read aloud". Pure: the browser's speech calls are in AccessibilityButton.tsx.
//
// Privacy rule: only voices that run ON this laptop are used (SpeechSynthesisVoice.localService).
// Some browser voices (Chrome's "Google …" ones) send the text to a server to be spoken. The screens can
// show real names, so those voices are never picked.

export interface VoiceInfo {
  name: string
  lang: string
  localService: boolean
  default?: boolean
}

/** True when at least one voice speaks on this laptop. */
export function hasLocalVoice(voices: readonly VoiceInfo[]): boolean {
  return voices.some((voice) => voice.localService)
}

/** The best local voice for a language like "en-US": same language and region, then same language, then the default one. */
export function pickLocalVoice<T extends VoiceInfo>(voices: readonly T[], lang: string): T | null {
  const local = voices.filter((voice) => voice.localService)
  if (local.length === 0) return null
  const want = lang.toLowerCase()
  const base = want.split('-')[0] ?? want
  const sameLang = (voice: T, exact: boolean) => {
    const have = voice.lang.toLowerCase().replace('_', '-')
    return exact ? have === want : have.split('-')[0] === base
  }
  return (
    local.find((voice) => sameLang(voice, true) && voice.default) ??
    local.find((voice) => sameLang(voice, true)) ??
    local.find((voice) => sameLang(voice, false) && voice.default) ??
    local.find((voice) => sameLang(voice, false)) ??
    local.find((voice) => voice.default) ??
    local[0] ??
    null
  )
}

/**
 * Cuts text into pieces a speech engine can handle. Chrome stops very long utterances after about 15 seconds,
 * so each piece is a sentence or two (up to `max` characters), split at line breaks and sentence ends.
 */
export function chunkForSpeech(text: string, max = 180): string[] {
  const chunks: string[] = []
  for (const line of text.split(/\n+/)) {
    const sentences = line.match(/[^.!?…]+[.!?…]*\s*/g) ?? []
    let current = ''
    for (const raw of sentences) {
      const sentence = raw.replace(/\s+/g, ' ').trim()
      if (!sentence) continue
      if (sentence.length > max) {
        if (current) chunks.push(current)
        current = ''
        // A very long sentence: cut at the last space before the limit.
        let rest = sentence
        while (rest.length > max) {
          const cut = rest.lastIndexOf(' ', max)
          const at = cut > 0 ? cut : max
          chunks.push(rest.slice(0, at).trim())
          rest = rest.slice(at).trim()
        }
        current = rest
        continue
      }
      if (current && current.length + 1 + sentence.length > max) {
        chunks.push(current)
        current = sentence
      } else {
        current = current ? `${current} ${sentence}` : sentence
      }
    }
    if (current) chunks.push(current)
  }
  return chunks
}
