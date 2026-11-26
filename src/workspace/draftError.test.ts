import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyDraftFailure, draftErrorMessage } from './draftError.ts'

test('a 429 in the message, a status field, or RESOURCE_EXHAUSTED is a quota failure', () => {
  assert.equal(classifyDraftFailure(new Error('AI: Error fetching from https://example.test: [429 ] Resource has been exhausted')), 'quota')
  assert.equal(classifyDraftFailure({ message: 'fetch failed', customErrorData: { status: 429 } }), 'quota')
  assert.equal(classifyDraftFailure({ name: 'FirebaseError', code: 'ai/fetch-error', customErrorData: { errorDetails: [{ reason: 'RESOURCE_EXHAUSTED' }], status: 'RESOURCE_EXHAUSTED' } }), 'quota')
  assert.equal(classifyDraftFailure(new Error('You exceeded your current quota')), 'quota')
})

test('503 and "overloaded" are busy; no connection is offline; anything else is other', () => {
  assert.equal(classifyDraftFailure(new Error('[503 ] The model is overloaded')), 'busy')
  assert.equal(classifyDraftFailure({ message: 'x', customErrorData: { status: 503 } }), 'busy')
  assert.equal(classifyDraftFailure(new TypeError('Failed to fetch')), 'offline')
  assert.equal(classifyDraftFailure(new Error('anything'), false), 'offline')
  assert.equal(classifyDraftFailure(new Error('[400 ] Bad request')), 'other')
  assert.equal(classifyDraftFailure('not an error'), 'other')
  assert.equal(classifyDraftFailure(null), 'other')
})

test('each message says the notes are safe and what to do next, and a 429 explains the shared allowance', () => {
  const quota = draftErrorMessage(new Error('[429 ] quota'))
  assert.match(quota, /free AI allowance/)
  assert.match(quota, /about a minute/)
  assert.match(quota, /midnight Pacific/)
  for (const error of [new Error('[429 ]'), new Error('[503 ]'), new TypeError('Failed to fetch'), new Error('boom')]) {
    assert.match(draftErrorMessage(error), /notes are safe on this laptop/)
  }
})

test('a message never repeats what the error said, so nothing from the notes can appear in it', () => {
  const message = draftErrorMessage(new Error('[429 ] Maria Santos has diabetes'))
  assert.ok(!/Maria|diabetes/.test(message))
})
