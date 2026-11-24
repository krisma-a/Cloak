import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEntities, emptyMap, restore } from './placeholders.ts'
import { findLeaks } from '../rules/rules.ts'
import { applyRawPolicy, resetPolicy } from '../policy.ts'
import { extendNameSpans, groupPhrases, leftoverNameParts, safetyNet } from './safetyNet.ts'

// All names and details here are made up.

test('ages are leaks, in the usual ways people write them', () => {
  for (const text of ['She is aged 41.', 'He is age 52.', 'A 29-year-old driver.', 'He is 63 years old.']) {
    assert.deepEqual(findLeaks(text).map((l) => l.category), ['AGE'], text)
  }
  assert.deepEqual(findLeaks('a short break every 2 hours, page 12 of the handbook'), [])
})

test('more salary formats are leaks: other currencies, lakh, bare k, per year / per hour', () => {
  for (const text of ['Offer: ₹9 lakh.', 'Severance: ₦310,000.', 'Pay: 78k.', 'Pay: 91.5k/yr.', 'Earns 64,000 a year.', 'Paid 19.75 an hour.', 'Paid 22.40/hr.', 'INR 12 lakh']) {
    assert.deepEqual(findLeaks(text).map((l) => l.category), ['SALARY'], text)
  }
  assert.deepEqual(findLeaks('Policy 3.2, meeting on Oct 3, 4 hours, 5k steps'), [])
})

test('redact_salary=false leaves the new money formats visible too', () => {
  applyRawPolicy({ redact_salary: 'false' }, { source: 'remote' })
  try {
    assert.deepEqual(findLeaks('Pay: 78k. Offer: ₹9 lakh.'), [])
  } finally {
    resetPolicy()
  }
})

test('team phrases that single someone out become DEPARTMENT, generic ones do not', () => {
  assert.deepEqual(
    groupPhrases('She works with the overnight loading team. He is on the Bay 2 returns unit. Ask the whole team.').map((e) => e.text),
    ['the overnight loading team', 'the Bay 2 returns unit'],
  )
  assert.deepEqual(groupPhrases('the HR team and the same crew'), [])
})

test('a hyphenated name found in pieces is widened to the whole name', () => {
  const text = 'Recommended by Seo-yeon Choi. Witness: Jae-ho.'
  assert.deepEqual(extendNameSpans(text, [{ text: 'Seo', category: 'ADDRESS' }, { text: 'Jae', category: 'PERSON' }]), [
    { text: 'Seo-yeon Choi', category: 'PERSON' },
    { text: 'Jae-ho', category: 'PERSON' },
  ])
  // A place with a capital after the hyphen stays a place.
  assert.deepEqual(extendNameSpans('She lives in Winston-Salem.', [{ text: 'Winston', category: 'ADDRESS' }]), [
    { text: 'Winston', category: 'ADDRESS' },
  ])
  // A name followed by an ordinary word is not widened past it.
  assert.deepEqual(extendNameSpans('Ask Jae-ho HR', [{ text: 'Jae', category: 'PERSON' }]), [{ text: 'Jae-ho', category: 'PERSON' }])
})

test('nicknames in quotes and glued name rests next to a placeholder are found', () => {
  assert.deepEqual(leftoverNameParts('Recommended by [EMPLOYEE_3] "Bea" [EMPLOYEE_2].'), [{ text: 'Bea', category: 'PERSON' }])
  assert.deepEqual(leftoverNameParts('Signed by [EMPLOYEE_1]-yeon Choi.'), [{ text: 'yeon Choi', category: 'PERSON' }])
  // "-jun": hiding "jun" would also hide the month in "Jun 11", so only the word after it goes.
  assert.deepEqual(leftoverNameParts('[EMPLOYEE_1]-jun Yoon met on Jun 11.'), [{ text: 'Yoon', category: 'PERSON' }])
})

test('safetyNet hides what Nano left behind and the text restores to the original', () => {
  const original = 'Case 25-001. [Note] Ana Reyes (aged 44) earns 81k on the night returns crew. She has asthma.'
  // Pretend Nano only found the name.
  const first = applyEntities(original, [{ text: 'Ana Reyes', category: 'PERSON' }], emptyMap())
  const net = safetyNet(first.text, first.map)
  assert.equal(net.added, 4)
  assert.doesNotMatch(net.text, /aged 44|81k|night returns crew|asthma|Ana|Reyes/)
  assert.match(net.text, /^Case 25-001\./) // the case number stays
  assert.equal(findLeaks(net.text, Object.keys(net.map.lookup)).length, 0)
  assert.equal(restore(net.text, net.map), original)
})

test('safetyNet respects what the settings allow to stay visible', () => {
  const start = applyEntities('Pay: 78k. Age: aged 30.', [], emptyMap())
  const net = safetyNet(start.text, start.map, (e) => e.category !== 'SALARY')
  assert.match(net.text, /78k/)
  assert.doesNotMatch(net.text, /aged 30/)
})
