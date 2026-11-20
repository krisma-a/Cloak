// Run with: npm test   (fake data only)
// Token fixtures copied from the real Xenova/bert-base-NER output for the fake sample note.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokensToEntities, type NerToken } from './browserModel.ts'

let i = 0
const t = (word: string, entity = 'O', score = 0.99): NerToken => ({ word, entity, score, index: i++ })

test('rebuilds unusual names from word pieces', () => {
  const tokens = [
    t('supervisor'), t(','),
    t('Chi', 'B-PER'), t('##di', 'B-PER'), t('Ok', 'I-PER'), t('##af', 'I-PER'), t('##or'), // "##or" untagged
    t(','), t('Witness'), t(':'),
    t('Ng', 'B-PER'), t('##uy', 'I-PER', 0.76), t('##en', 'B-PER', 0.88),
    t('T', 'I-PER'), t('##hi', 'I-PER', 0.78), t('La', 'I-PER', 0.94), t('##n', 'I-PER', 0.72),
    t(','), t('the'),
  ]
  const people = tokensToEntities(tokens).filter((e) => e.category === 'PERSON').map((e) => e.text)
  assert.ok(people.includes('Chidi Okafor'), `got ${JSON.stringify(people)}`)
  assert.ok(people.includes('Nguyen Thi Lan'), `got ${JSON.stringify(people)}`)
})

test('keeps two different names apart and ignores organisations', () => {
  const tokens = [
    t('Maria', 'B-PER'), t('Santos', 'I-PER'), t('and'),
    t('Ana', 'B-PER'), t('works'), t('at'), t('Acme', 'B-ORG'), t('in'), t('Cebu', 'B-LOC'), t('.'),
  ]
  assert.deepEqual(tokensToEntities(tokens), [
    { text: 'Maria Santos', category: 'PERSON' },
    { text: 'Maria', category: 'PERSON' },
    { text: 'Santos', category: 'PERSON' },
    { text: 'Ana', category: 'PERSON' },
    { text: 'Cebu', category: 'ADDRESS' },
  ])
})

test('joins hyphenated names', () => {
  const tokens = [
    t('Jun', 'B-PER'), t('-'), t('Jun', 'B-PER'), t('dela', 'I-PER'), t('Cruz', 'I-PER'), t('said'),
    t('the'), t('2019'), t('-'), t('2020'), t('report'),
  ]
  const people = tokensToEntities(tokens).map((e) => e.text)
  assert.equal(people[0], 'Jun-Jun dela Cruz')
  assert.ok(!people.some((p) => p.includes('2019')))
})

test('ignores low-confidence guesses', () => {
  assert.deepEqual(tokensToEntities([t('E', 'B-ORG', 0.52), t('Case', 'B-PER', 0.3)]), [])
})
