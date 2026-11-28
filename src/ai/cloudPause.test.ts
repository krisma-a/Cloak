// Run with: npm test   (fake data only)
// The cloud-drafting kill switch: no cloud call while it is off, back to "on" when the value is missing,
// and a 429 gets the friendly message after a single call (no retry storm).
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { draftErrorMessage } from '../workspace/draftError.ts'
import { assertCloudDraftsEnabled, cloudDraftsPaused, PAUSED_NOTICE, whenCloudDraftsEnabled } from './cloudPause.ts'
import { CloudPausedError, SendBlockedError } from './errors.ts'
import { applyRawPolicy, DEFAULT_POLICY, getPolicy, parsePolicy, POLICY_KEYS, resetPolicy } from '../policy.ts'

afterEach(() => resetPolicy())

const use = (raw: Parameters<typeof applyRawPolicy>[0]) => applyRawPolicy(raw, { source: 'remote' })

test('flag false: no cloud call is made, and the paused notice is the error text', async () => {
  use({ cloud_drafts_enabled: 'false' })
  let calls = 0
  const cloud = async () => {
    calls += 1
    return 'a draft'
  }
  await assert.rejects(
    () => whenCloudDraftsEnabled(getPolicy(), cloud),
    (error: unknown) => error instanceof CloudPausedError && error.message === PAUSED_NOTICE,
  )
  assert.equal(calls, 0, 'the cloud call must never start while drafting is paused')
  assert.equal(PAUSED_NOTICE, 'Drafting is paused right now. Your notes were still hidden on this device, and nothing was sent.')
})

test('a paused draft is not a refused send, so it is never logged as "blocked"', () => {
  assert.ok(!(new CloudPausedError('x') instanceof SendBlockedError))
})

test('flag missing: behaves as true', async () => {
  assert.equal(DEFAULT_POLICY.cloud_drafts_enabled, true)
  assert.equal(getPolicy().cloud_drafts_enabled, true)
  use({}) // Remote Config answered, but without this parameter
  assert.equal(getPolicy().cloud_drafts_enabled, true)
  assert.equal(parsePolicy({ cloud_drafts_enabled: '   ' }).policy.cloud_drafts_enabled, true)
  let calls = 0
  const result = await whenCloudDraftsEnabled(getPolicy(), async () => {
    calls += 1
    return 'a draft'
  })
  assert.equal(result, 'a draft')
  assert.equal(calls, 1)
})

test('if Remote Config cannot be fetched, the built-in default (on) stays in force', () => {
  // remoteConfig.ts then never calls applyRawPolicy, so the store keeps the defaults.
  assert.equal(cloudDraftsPaused(getPolicy()), false)
  assert.doesNotThrow(() => assertCloudDraftsEnabled(getPolicy()))
})

test('the switch reads true/false words, and a value it cannot read pauses with a warning', () => {
  for (const word of ['true', 'TRUE', '1', 'yes', 'on']) assert.equal(parsePolicy({ cloud_drafts_enabled: word }).policy.cloud_drafts_enabled, true)
  for (const word of ['false', 'False', '0', 'no', 'off']) assert.equal(parsePolicy({ cloud_drafts_enabled: word }).policy.cloud_drafts_enabled, false)
  const odd = parsePolicy({ cloud_drafts_enabled: 'maybe' })
  assert.equal(odd.policy.cloud_drafts_enabled, false)
  assert.match(odd.warnings.join(' '), /cloud_drafts_enabled/)
})

test('flipping the switch takes effect on the next action, and back', async () => {
  use({ cloud_drafts_enabled: 'false' })
  assert.equal(cloudDraftsPaused(getPolicy()), true)
  use({ cloud_drafts_enabled: 'true' })
  assert.equal(cloudDraftsPaused(getPolicy()), false)
  use({ cloud_drafts_enabled: 'false' })
  use({}) // the parameter is deleted in the console: back to the default
  assert.equal(cloudDraftsPaused(getPolicy()), false)
})

test('a mocked 429 gets the friendly message after exactly one call', async () => {
  let calls = 0
  const rateLimited = async () => {
    calls += 1
    // Shaped like the SDK's error, with a private-looking value inside to prove it can't surface.
    throw new Error('AI: Error fetching from https://example.test: [429 ] Resource has been exhausted (Maria Santos, EMP-40912)')
  }
  let caught: unknown
  try {
    await whenCloudDraftsEnabled(getPolicy(), rateLimited)
  } catch (error) {
    caught = error
  }
  assert.equal(calls, 1, 'no retry: one call, one failure')
  const message = draftErrorMessage(caught)
  assert.match(message, /allowance is used up for the moment/)
  assert.match(message, /about a minute/)
  assert.match(message, /notes are safe on this laptop/)
  assert.ok(!/Maria|EMP-40912|429|example\.test/.test(message), 'nothing from the error may appear in the message')
})

test('the Remote Config template lists every setting, and the kill switch is a boolean that defaults to true', () => {
  const template = JSON.parse(readFileSync(new URL('../../remoteconfig.template.json', import.meta.url), 'utf8')) as {
    parameters: Record<string, { defaultValue: { value: string }; valueType: string }>
  }
  assert.deepEqual(Object.keys(template.parameters).sort(), [...POLICY_KEYS].sort())
  assert.equal(template.parameters.cloud_drafts_enabled?.valueType, 'BOOLEAN')
  assert.equal(template.parameters.cloud_drafts_enabled?.defaultValue.value, 'true')
})
