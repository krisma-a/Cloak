import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadCheckMode, parseCheckMode, saveCheckMode } from './checkMode.ts'

test('only "basic" picks basic checks; anything else falls back to Full Cloak', () => {
  assert.equal(parseCheckMode('basic'), 'basic')
  for (const raw of ['full', 'BASIC', '', null, undefined, 'rules-only']) assert.equal(parseCheckMode(raw), 'full')
})

test('the choice is remembered, and blocked storage never breaks the page', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  assert.equal(loadCheckMode(storage), 'full')
  saveCheckMode('basic', storage)
  assert.equal(loadCheckMode(storage), 'basic')

  const blocked = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
  assert.equal(loadCheckMode(blocked), 'full')
  assert.doesNotThrow(() => saveCheckMode('basic', blocked))
  assert.equal(loadCheckMode(undefined), 'full')
})
