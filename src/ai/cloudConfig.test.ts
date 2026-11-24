import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudGenerationConfig } from './cloudConfig.ts'

test('Gemini 3.x models think at LOW', () => {
  for (const model of ['gemini-3.6-flash', 'gemini-3.6-pro', 'gemini-3-flash', 'gemini-3']) {
    assert.deepEqual(cloudGenerationConfig(model), { thinkingConfig: { thinkingLevel: 'LOW' } }, model)
  }
})

test('other models keep their own default (Gemini 2.5 rejects thinkingLevel)', () => {
  for (const model of ['gemini-2.5-flash', 'gemini-30-flash', 'gemini-4-flash', '']) {
    assert.equal(cloudGenerationConfig(model), undefined, model)
  }
})
