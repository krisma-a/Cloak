import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkLanguage, MIN_CONFIDENCE, NOT_ENGLISH_NOTICE, safeLanguageCode } from './language.ts'
import type { DetectorLike } from './language.ts'

// Fake detector: answers with whatever it is told to, and remembers what it was asked. No real note here.
function fake(results: Array<{ detectedLanguage: string | null; confidence: number }>) {
  const seen: string[] = []
  const detector: DetectorLike = {
    async detect(text) {
      seen.push(text)
      return results
    },
  }
  return { detector, seen }
}

const SPANISH = 'La empleada pidió un cambio de horario porque cuida a su familia por las tardes.'
const ENGLISH = 'The employee asked for a schedule change because she looks after family in the evenings.'

describe('checkLanguage', () => {
  it('does nothing when the browser has no detector', async () => {
    assert.equal(await checkLanguage(ENGLISH, null), null)
  })

  it('accepts English at 0.7 or higher', async () => {
    const { detector } = fake([{ detectedLanguage: 'en', confidence: MIN_CONFIDENCE }])
    assert.deepEqual(await checkLanguage(ENGLISH, detector), { lang: 'en', notEnglish: false })
  })

  it('accepts a regional English', async () => {
    const { detector } = fake([{ detectedLanguage: 'en-GB', confidence: 0.9 }])
    assert.equal((await checkLanguage(ENGLISH, detector))?.notEnglish, false)
  })

  it('flags another language', async () => {
    const { detector } = fake([
      { detectedLanguage: 'es', confidence: 0.96 },
      { detectedLanguage: 'en', confidence: 0.02 },
    ])
    assert.deepEqual(await checkLanguage(SPANISH, detector), { lang: 'es', notEnglish: true })
  })

  it('flags English that is not sure enough', async () => {
    const { detector } = fake([{ detectedLanguage: 'en', confidence: 0.69 }])
    assert.deepEqual(await checkLanguage(ENGLISH, detector), { lang: 'en', notEnglish: true })
  })

  it('does not trust a lower English reading if no English reading reaches 0.7', async () => {
    const { detector } = fake([
      { detectedLanguage: 'fr', confidence: 0.5 },
      { detectedLanguage: 'en', confidence: 0.4 },
    ])
    assert.equal((await checkLanguage(ENGLISH, detector))?.notEnglish, true)
  })

  it('skips text with too few letters to judge', async () => {
    const { detector, seen } = fake([{ detectedLanguage: 'es', confidence: 0.99 }])
    assert.equal(await checkLanguage('EMP-40912, 3/4/2026', detector), null)
    assert.equal(seen.length, 0)
  })

  it('looks at the start of a long note only', async () => {
    const { detector, seen } = fake([{ detectedLanguage: 'en', confidence: 0.99 }])
    await checkLanguage(ENGLISH.repeat(100), detector)
    assert.ok((seen[0]?.length ?? 0) <= 1000)
  })

  it('stays silent when the detector fails or has nothing to say', async () => {
    const broken: DetectorLike = {
      async detect() {
        throw new Error('model unavailable')
      },
    }
    assert.equal(await checkLanguage(ENGLISH, broken), null)
    assert.equal(await checkLanguage(ENGLISH, fake([]).detector), null)
  })

  it('reports "und" when the detector cannot name the language', async () => {
    const { detector } = fake([{ detectedLanguage: null, confidence: 0.4 }])
    assert.deepEqual(await checkLanguage(SPANISH, detector), { lang: 'und', notEnglish: true })
  })
})

describe('safeLanguageCode', () => {
  it('keeps real codes and drops anything else', () => {
    assert.equal(safeLanguageCode('es'), 'es')
    assert.equal(safeLanguageCode('zh-Hant'), 'zh-Hant')
    assert.equal(safeLanguageCode('Maria Santos'), 'und')
    assert.equal(safeLanguageCode(null), 'und')
    assert.equal(safeLanguageCode(''), 'und')
  })
})

describe('the notice', () => {
  it('says what was asked for', () => {
    assert.match(NOT_ENGLISH_NOTICE, /isn’t in English/)
    assert.match(NOT_ENGLISH_NOTICE, /Basic checks/)
    assert.match(NOT_ENGLISH_NOTICE, /review carefully/)
  })
})
