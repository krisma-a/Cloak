import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorCorrection, formatBits, penalty, qrMatrix, qrPath, versionBits } from './qr.ts'

test('format and version bits match the values in the QR code standard', () => {
  assert.equal(formatBits(0), 0b101010000010010) // level M, mask 0
  assert.equal(formatBits(1), 0b101000100100101) // level M, mask 1
  assert.equal(versionBits(7), 0b000111110010010100)
})

test('error correction matches the standard worked example (version 1-M, "HELLO WORLD")', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
  assert.deepEqual(errorCorrection(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
})

test('Cloak’s address fits a small code with all three finder patterns in place', () => {
  const m = qrMatrix('https://cloak.web.app')
  assert.equal(m.length, 25) // version 2: 21 bytes need more than version 1-M holds
  assert.ok(m.every((row) => row.length === 25))
  const finderAt = (top: number, left: number) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        assert.equal(m[top + r]?.[left + c], ring !== 2, `finder at ${top},${left} module ${r},${c}`)
      }
    }
  }
  finderAt(0, 0)
  finderAt(0, 18)
  finderAt(18, 0)
  assert.equal(m[25 - 8]?.[8], true, 'the dark module')
  // Timing pattern alternates along row 6.
  for (let c = 8; c < 17; c++) assert.equal(m[6]?.[c], c % 2 === 0)
})

test('longer text picks a bigger version, and too much text is refused', () => {
  assert.equal(qrMatrix('x'.repeat(100)).length, 4 * 6 + 17) // version 6
  assert.equal(qrMatrix('x'.repeat(200)).length, 4 * 10 + 17) // version 10
  assert.throws(() => qrMatrix('x'.repeat(300)), RangeError)
})

test('the same text always gives the same code, drawn as one path with a margin', () => {
  const a = qrMatrix('https://cloak.web.app')
  assert.deepEqual(qrMatrix('https://cloak.web.app'), a)
  const path = qrPath(a)
  assert.ok(path.startsWith('M4 4h1v1h-1z'), 'top-left finder starts after the 4-module margin')
  assert.equal(path.split('M').length - 1, a.flat().filter(Boolean).length)
  assert.ok(penalty(a) > 0)
})
