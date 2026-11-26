import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserName, markSpecsSeen, shouldShowSpecs, specRows, specsSeen, specsTitle } from './specs.ts'
import type { DeviceInfo } from './specs.ts'

const MAC_CHROME: DeviceInfo = {
  brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }],
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150.0 Safari/537.36',
  platform: 'macOS',
  mobile: false,
  coarsePointer: false,
  cores: 8,
  memoryGb: 8,
  privateAi: true,
}

const mark = (info: DeviceInfo, label: string) => specRows(info).find((r) => r.label === label)?.mark

test('a capable Chrome laptop with the private AI ready sees no notice', () => {
  assert.equal(shouldShowSpecs(MAC_CHROME), false)
  assert.equal(mark(MAC_CHROME, 'Browser'), 'ok')
  assert.equal(mark(MAC_CHROME, 'Processor'), 'ok')
  assert.equal(mark(MAC_CHROME, 'Memory'), 'unknown', '8 GB reported can’t confirm 16')
  assert.equal(mark(MAC_CHROME, 'Free space'), 'unknown')
})

test('Chrome without the private AI, or with few cores or little memory, gets the notice', () => {
  assert.equal(shouldShowSpecs({ ...MAC_CHROME, privateAi: false }), true)
  assert.equal(specsTitle({ ...MAC_CHROME, privateAi: false }), 'Cloak may be slower on this laptop')
  assert.equal(mark({ ...MAC_CHROME, privateAi: false, cores: 2 }, 'Processor'), 'short')
  assert.equal(mark({ ...MAC_CHROME, privateAi: false, memoryGb: 4 }, 'Memory'), 'short')
  assert.equal(shouldShowSpecs({ ...MAC_CHROME, privateAi: null }), false, 'waits until the check finishes')
  // The private AI works but the laptop is slow: worth offering basic checks.
  assert.equal(shouldShowSpecs({ ...MAC_CHROME, cores: 2 }), true)
  assert.equal(shouldShowSpecs({ ...MAC_CHROME, memoryGb: 4 }), true)
})

test('another browser or a phone gets the notice with the matching headline', () => {
  const brave = { ...MAC_CHROME, brands: [{ brand: 'Brave' }, { brand: 'Chromium' }], privateAi: false }
  assert.equal(shouldShowSpecs(brave), true)
  assert.equal(specsTitle(brave), 'Cloak works best in Chrome')
  assert.equal(browserName(brave), 'Brave')
  assert.equal(browserName({ brands: [{ brand: 'Chromium' }, { brand: 'Not=A?Brand' }], userAgent: 'Chrome/150.0' }), 'Chromium')
  const safari = { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18 Safari/605', coarsePointer: false, privateAi: null }
  assert.equal(browserName(safari), 'Safari')
  assert.equal(shouldShowSpecs(safari), true)
  const phone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604', coarsePointer: true, privateAi: false }
  assert.equal(specsTitle(phone), 'Cloak works best on a laptop')
  assert.equal(mark(phone, 'System'), 'short')
})

test('"seen" is remembered, and blocked storage never breaks the page', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  assert.equal(specsSeen(storage), false)
  markSpecsSeen(storage)
  assert.equal(specsSeen(storage), true)
  const blocked = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
  assert.equal(specsSeen(blocked), false)
  assert.doesNotThrow(() => markSpecsSeen(blocked))
})
