import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allowedFields, blockReasonCode, BLOCK_REASONS, buildAnalyticsEvent } from './analyticsEvents.ts'
import type { AnalyticsEventName } from './analyticsEvents.ts'

// Everything below is made up. The "secrets" stand for what must never reach Analytics.
const SECRETS = ['Maria Santos', 'EMP-40912', 'maria.santos@example.com', 'case-notes-march.pdf', '[EMPLOYEE_1]']

const EVENTS: Record<AnalyticsEventName, string[]> = {
  redact_done: ['engine', 'details_hidden'],
  draft_done: ['template', 'model'],
  send_blocked: ['reason'],
  scan_done: ['pages', 'rechecked_fixed'],
  language_fallback: ['lang'],
}

describe('analytics events', () => {
  it('has exactly the five events that were asked for', () => {
    assert.deepEqual(Object.keys(EVENTS).sort(), ['draft_done', 'language_fallback', 'redact_done', 'scan_done', 'send_blocked'])
  })

  for (const [name, keys] of Object.entries(EVENTS) as Array<[AnalyticsEventName, string[]]>) {
    it(`${name} carries only ${keys.join(' and ')}`, () => {
      assert.deepEqual(allowedFields(name).sort(), [...keys].sort())
      // Hand it every field plus a pile of extras full of private things: only the allowed keys come out.
      const junk: Record<string, unknown> = { noteText: SECRETS[0], name: SECRETS[0], fileName: SECRETS[3], redacted: SECRETS[4], email: SECRETS[2] }
      for (const key of keys) junk[key] = SECRETS[1]
      const event = buildAnalyticsEvent(name, junk)
      assert.ok(event)
      assert.deepEqual(Object.keys(event.params).sort(), [...keys].sort())
      const text = JSON.stringify(event)
      for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} leaked into ${name}`)
    })
  }

  it('drops events that are not one of the five', () => {
    assert.equal(buildAnalyticsEvent('page_view', { page: 'x' }), null)
    assert.equal(buildAnalyticsEvent('note_text', { text: SECRETS[0] }), null)
    assert.equal(buildAnalyticsEvent('constructor'), null)
    assert.equal(buildAnalyticsEvent('toString'), null)
  })

  it('keeps good values', () => {
    assert.deepEqual(buildAnalyticsEvent('redact_done', { engine: 'nano', details_hidden: 11 })?.params, { engine: 'nano', details_hidden: 11 })
    assert.deepEqual(buildAnalyticsEvent('draft_done', { template: 'investigation', model: 'gemini-3.6-flash' })?.params, {
      template: 'investigation',
      model: 'gemini-3.6-flash',
    })
    assert.deepEqual(buildAnalyticsEvent('scan_done', { pages: 3, rechecked_fixed: 2 })?.params, { pages: 3, rechecked_fixed: 2 })
    assert.deepEqual(buildAnalyticsEvent('language_fallback', { lang: 'es' })?.params, { lang: 'es' })
  })

  it('turns anything unexpected into a plain fallback, never the value', () => {
    assert.deepEqual(buildAnalyticsEvent('redact_done', { engine: SECRETS[0], details_hidden: SECRETS[1] })?.params, { engine: 'other', details_hidden: 0 })
    assert.equal(buildAnalyticsEvent('draft_done', { template: SECRETS[0], model: `${SECRETS[0]} model` })?.params.model, 'unknown')
    assert.equal(buildAnalyticsEvent('draft_done', { template: SECRETS[0] })?.params.template, 'other')
    assert.equal(buildAnalyticsEvent('language_fallback', { lang: SECRETS[0] })?.params.lang, 'und')
    assert.equal(buildAnalyticsEvent('scan_done', { pages: -4, rechecked_fixed: Number.NaN })?.params.pages, 0)
    assert.equal(buildAnalyticsEvent('scan_done', { pages: 1e9 })?.params.pages, 10_000)
    assert.equal(buildAnalyticsEvent('send_blocked', { reason: `contains a private detail ("${SECRETS[0]}")` })?.params.reason, 'other')
  })

  it('fills missing fields with fallbacks, so the keys are always the same', () => {
    assert.deepEqual(buildAnalyticsEvent('redact_done')?.params, { engine: 'other', details_hidden: 0 })
  })
})

describe('blockReasonCode', () => {
  it('maps each real refusal message to a fixed reason', () => {
    assert.equal(blockReasonCode('Not sent: redaction is blocked (something still leaks).'), 'redaction_blocked')
    assert.equal(blockReasonCode('Not sent: names have not been checked. Enter the names in this case, or confirm there are none.'), 'names_unchecked')
    assert.equal(blockReasonCode('Not sent: the leak re-check found 2 item(s) still visible.'), 'leak_found')
    assert.equal(blockReasonCode('Not sent: this note has medical details and medical mode is "block". Remove them.'), 'medical_blocked')
    assert.equal(blockReasonCode('Not sent: the user has not approved the redacted text.'), 'not_approved')
    assert.equal(blockReasonCode('Not sent: could not save the receipt on this device, so nothing was sent.'), 'receipt_failed')
    assert.equal(blockReasonCode('Not sent: add at least one work restriction. A manager email uses only restrictions.'), 'restrictions')
    assert.equal(blockReasonCode('Not sent: choose which employee the restrictions are for.'), 'restrictions')
  })

  it('never lets a quoted private detail through', () => {
    const quoted = `Not sent: restriction 1 contains a private detail ("${SECRETS[0]}").`
    const code = blockReasonCode(quoted)
    assert.equal(code, 'restrictions')
    assert.ok(!code.includes('Maria'))
    assert.ok((BLOCK_REASONS as readonly string[]).includes(blockReasonCode('something else entirely')))
    assert.equal(blockReasonCode('something else entirely'), 'other')
  })
})
