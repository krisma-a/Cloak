// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReceipt, sha256Hex } from './receipt.ts'

test('sha256 matches the known value', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('receipt records what was sent and where each step ran', async () => {
  const receipt = await buildReceipt(
    'Notes: [EMPLOYEE_1] ...',
    'gemini-3.6-flash',
    [
      { step: 'redaction', ranOn: 'on_device' },
      { step: 'drafting', ranOn: 'in_cloud' },
    ],
    new Date('2026-11-21T10:00:00Z'),
  )
  assert.equal(receipt.sha256, await sha256Hex('Notes: [EMPLOYEE_1] ...'))
  assert.equal(receipt.sentAt, '2026-11-21T10:00:00.000Z')
  assert.deepEqual(receipt.steps.map((s) => s.ranOn), ['on_device', 'in_cloud'])
})
