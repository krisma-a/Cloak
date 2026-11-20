// Run with: npm test   (fake data only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findLeaks } from './rules.ts'

const categories = (text: string, known: string[] = []) =>
  findLeaks(text, known).map((l) => l.category)

test('catches fixed-shape identifiers', () => {
  assert.deepEqual(categories('SSN 123-45-6789'), ['SSN'])
  assert.deepEqual(categories('mail maria.s@example.com'), ['EMAIL'])
  assert.deepEqual(categories('call (555) 201-7788'), ['PHONE'])
  assert.deepEqual(categories('call +63 917 123 4567'), ['PHONE'])
  assert.deepEqual(categories('born 03/14/1988'), ['DATE'])
  assert.deepEqual(categories('born 1988-03-14'), ['DATE'])
  assert.deepEqual(categories('paid $68,500 a year'), ['SALARY'])
  assert.deepEqual(categories('paid PHP 45,000'), ['SALARY'])
  assert.deepEqual(categories('badge EMP-40912'), ['EMPLOYEE_ID'])
})

test('allows placeholders and dates without a year', () => {
  assert.deepEqual(
    categories('[EMPLOYEE_1] earns [SALARY_1]; meeting on Oct 3 with [EMPLOYEE_2]'),
    [],
  )
})

test('catches known names as whole words, any case', () => {
  assert.deepEqual(categories('then maria left', ['Maria']), ['KNOWN'])
  assert.deepEqual(categories('Mariana left', ['Maria']), [])
  assert.deepEqual(categories('Nguyễn Thị Lan was there', ['Nguyễn Thị Lan']), ['KNOWN'])
})

test('catches phrases that single someone out', () => {
  const found = (text: string) => findLeaks(text).filter((l) => l.category === 'INDIRECT').map((l) => l.text)
  assert.deepEqual(found('Witness: [EMPLOYEE_1], the only woman on the night warehouse crew.'), [
    'the only woman on the night warehouse crew',
  ])
  assert.deepEqual(found('She is the only Filipino nurse in the ICU.'), [
    'the only Filipino nurse in the ICU',
  ])
  assert.deepEqual(found('He is the youngest engineer.'), ['the youngest engineer'])
})

test('allows ordinary "only" phrases and partly hidden ones', () => {
  const found = (text: string) => findLeaks(text).filter((l) => l.category === 'INDIRECT')
  assert.deepEqual(found('The only option is to escalate.'), [])
  assert.deepEqual(found('The only witness was [EMPLOYEE_1].'), [])
  assert.deepEqual(found('Witness: [EMPLOYEE_1], the only woman on [DEPT_1].'), [])
  assert.deepEqual(found('Witness: [EMPLOYEE_1], [ROLE_1].'), [])
})

test('reports each leak once', () => {
  assert.equal(findLeaks('Maria, Maria, MARIA', ['Maria']).length, 1)
})
