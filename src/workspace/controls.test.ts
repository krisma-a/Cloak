import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { A11Y_KEY, DEFAULT_A11Y, a11yAttributes, isDefaultA11y, parseA11y, stepTextSize } from './a11y.ts'
import { IDLE_WARNING_SECONDS, idleStatus, saveFileName, writeSummary } from './controls.ts'
import { chunkForSpeech, hasLocalVoice, pickLocalVoice } from './speech.ts'

describe('idleStatus', () => {
  const minute = 60_000

  it('is active until the warning begins', () => {
    const state = idleStatus(10 * minute, 0, 15)
    assert.equal(state.status, 'active')
  })

  it('warns for the last minute, counting down', () => {
    const state = idleStatus(14 * minute + 30_000, 0, 15)
    assert.equal(state.status, 'warning')
    assert.equal(state.secondsLeft, 30)
    assert.equal(idleStatus(14 * minute, 0, 15).secondsLeft, IDLE_WARNING_SECONDS)
  })

  it('expires at the limit', () => {
    assert.equal(idleStatus(15 * minute, 0, 15).status, 'expired')
    assert.equal(idleStatus(99 * minute, 0, 15).status, 'expired')
  })

  it('treats a clock that went backwards as just active', () => {
    assert.equal(idleStatus(0, 5 * minute, 15).status, 'active')
  })
})

describe('saveFileName', () => {
  it('uses the kind of case and the date, nothing else', () => {
    assert.equal(saveFileName('investigation', 'pdf', new Date(2026, 10, 5)), 'cloak-investigation-draft-2026-11-05.pdf')
    assert.equal(saveFileName('accommodation', 'txt', new Date(2026, 0, 31)), 'cloak-accommodation-draft-2026-01-31.txt')
  })

  it('strips anything that is not a letter or a hyphen', () => {
    assert.equal(saveFileName('../Maria Santos!', 'txt', new Date(2026, 10, 5)), 'cloak-mariasantos-draft-2026-11-05.txt')
    assert.equal(saveFileName('123', 'pdf', new Date(2026, 10, 5)), 'cloak-case-draft-2026-11-05.pdf')
  })
})

describe('writeSummary', () => {
  it('says nothing is sent in demo mode', () => {
    const summary = writeSummary({ hidden: 4, kept: 0, characters: 900, restrictionsOnly: false, realAi: false })
    assert.deepEqual(summary.sent, ['Nothing. This is a demo draft.'])
    assert.ok(summary.stays.length > 0)
  })

  it('counts what goes to the cloud in real mode', () => {
    const summary = writeSummary({ hidden: 4, kept: 1, characters: 1204, restrictionsOnly: false, realAi: true })
    assert.match(summary.sent[0] ?? '', /1,204 characters/)
    assert.match(summary.sent[1] ?? '', /4 private details/)
    assert.match(summary.sent[2] ?? '', /1 detail you chose to keep visible/)
  })

  it('says it plainly when nothing was hidden', () => {
    const summary = writeSummary({ hidden: 0, kept: 0, characters: 10, restrictionsOnly: false, realAi: true })
    assert.match(summary.sent.join(' '), /nothing was hidden/)
  })

  it('sends only the restrictions for a manager email', () => {
    const summary = writeSummary({ hidden: 6, kept: 2, characters: 500, restrictionsOnly: true, realAi: true })
    assert.match(summary.sent.join(' '), /work restrictions/)
    assert.doesNotMatch(summary.sent.join(' '), /characters/)
  })
})

describe('parseA11y', () => {
  it('uses the defaults when nothing is saved or it is damaged', () => {
    assert.deepEqual(parseA11y(null), DEFAULT_A11Y)
    assert.deepEqual(parseA11y('not json'), DEFAULT_A11Y)
    assert.deepEqual(parseA11y('42'), DEFAULT_A11Y)
    assert.deepEqual(parseA11y('null'), DEFAULT_A11Y)
  })

  it('keeps good values and rejects the rest one by one', () => {
    const parsed = parseA11y(
      JSON.stringify({ textSize: 130, highContrast: true, roomySpacing: 'yes', speed: 9, idleMinutes: 45 }),
    )
    assert.equal(parsed.textSize, 130)
    assert.equal(parsed.highContrast, true)
    assert.equal(parsed.roomySpacing, false)
    assert.equal(parsed.speed, 1.3)
    assert.equal(parsed.idleMinutes, 15)
  })

  it('round-trips what the panel saves', () => {
    const settings = { ...DEFAULT_A11Y, textSize: 150 as const, reduceMotion: true, speed: 0.8, idleMinutes: 60 as const }
    assert.deepEqual(parseA11y(JSON.stringify(settings)), settings)
    assert.equal(A11Y_KEY, 'cloak.a11y')
  })
})

describe('text size and attributes', () => {
  it('steps through the sizes and stops at the ends', () => {
    assert.equal(stepTextSize(100, 1), 115)
    assert.equal(stepTextSize(150, 1), 150)
    assert.equal(stepTextSize(100, -1), 100)
    assert.equal(stepTextSize(130, -1), 115)
  })

  it('writes no attributes for the defaults', () => {
    assert.ok(isDefaultA11y(DEFAULT_A11Y))
    assert.deepEqual(Object.values(a11yAttributes(DEFAULT_A11Y)).filter(Boolean), [])
  })

  it('writes the attributes the stylesheet reads', () => {
    const attrs = a11yAttributes({ ...DEFAULT_A11Y, textSize: 130, highContrast: true, roomySpacing: true, reduceMotion: true })
    assert.equal(attrs['data-text-size'], '130')
    assert.equal(attrs['data-contrast'], 'high')
    assert.equal(attrs['data-spacing'], 'roomy')
    assert.equal(attrs['data-motion'], 'reduced')
  })
})

describe('speech voices', () => {
  const voices = [
    { name: 'Google US English', lang: 'en-US', localService: false },
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Daniel', lang: 'en-GB', localService: true, default: true },
    { name: 'Amelie', lang: 'fr_CA', localService: true },
  ]

  it('never picks a voice that sends the text away', () => {
    const picked = pickLocalVoice(voices, 'en-US')
    assert.equal(picked?.name, 'Samantha')
    assert.equal(pickLocalVoice([voices[0]!], 'en-US'), null)
    assert.equal(hasLocalVoice([voices[0]!]), false)
    assert.equal(hasLocalVoice(voices), true)
  })

  it('falls back to the same language, then the default voice', () => {
    assert.equal(pickLocalVoice(voices, 'en-AU')?.name, 'Daniel')
    assert.equal(pickLocalVoice(voices, 'fr-CA')?.name, 'Amelie')
    assert.equal(pickLocalVoice(voices, 'de-DE')?.name, 'Daniel')
  })
})

describe('chunkForSpeech', () => {
  it('keeps short sentences together and splits at line breaks', () => {
    assert.deepEqual(chunkForSpeech('Your draft. Real names are back.\nSecond line.'), ['Your draft. Real names are back.', 'Second line.'])
  })

  it('splits long text into pieces under the limit', () => {
    const text = Array.from({ length: 20 }, (_, i) => `This is sentence number ${i + 1}.`).join(' ')
    const chunks = chunkForSpeech(text, 100)
    assert.ok(chunks.length > 3)
    assert.ok(chunks.every((chunk) => chunk.length <= 100))
    assert.equal(chunks.join(' '), text)
  })

  it('cuts a very long sentence at a space', () => {
    const chunks = chunkForSpeech(`${'word '.repeat(80)}end`, 50)
    assert.ok(chunks.every((chunk) => chunk.length <= 50))
    assert.equal(chunks.join(' ').replace(/\s+/g, ' '), `${'word '.repeat(80)}end`)
  })

  it('returns nothing for empty text', () => {
    assert.deepEqual(chunkForSpeech('  \n  '), [])
  })
})
