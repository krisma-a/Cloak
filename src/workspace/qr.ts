// A small QR code encoder, written for Cloak from the QR code standard (ISO/IEC 18004), so the code that opens Cloak on
// a phone is drawn in this page: no outside QR service ever sees the address, and no outside code is added.
// Pure (no DOM), so tests run in Node.
//
// Scope, kept small on purpose: byte mode (UTF-8), error correction level M (about 15% of the code can be damaged and
// it still reads), versions 1 to 10 (up to 213 bytes, far more than a web address needs). The mask is chosen by the
// standard's penalty rules.

/** Version 1–10, error correction M: [EC codewords per block, blocks in group 1, data codewords each, group 2, each]. */
const BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
]

/** Centre rows/columns of the alignment patterns, versions 1–10. */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

export const MAX_VERSION = BLOCKS_M.length

function dataCodewords(version: number): number {
  const [, b1, d1, b2, d2] = BLOCKS_M[version - 1] as readonly [number, number, number, number, number]
  return b1 * d1 + b2 * d2
}

// ---------------------------------------------------------------------------------------------
// Reed–Solomon over GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)

function gfMultiply(a: number, b: number): number {
  let product = 0
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    if ((b >>> bit) & 1) product ^= a
  }
  return product & 0xff
}

/** The generator polynomial (x − α^0)(x − α^1)…(x − α^(n−1)), highest power first, leading 1 left out. */
function generator(degree: number): number[] {
  let poly = [1]
  let root = 1
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j] as number
      next[j + 1] ^= gfMultiply(poly[j] as number, root)
    }
    poly = next
    root = gfMultiply(root, 2)
  }
  return poly.slice(1)
}

/** The error correction codewords for one block: the remainder of data · x^n divided by the generator. */
export function errorCorrection(data: readonly number[], degree: number): number[] {
  const gen = generator(degree)
  const remainder = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number)
    remainder.push(0)
    for (let i = 0; i < degree; i++) remainder[i] = (remainder[i] as number) ^ gfMultiply(gen[i] as number, factor)
  }
  return remainder
}

// ---------------------------------------------------------------------------------------------
// Data → codewords

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const countBits = version < 10 ? 8 : 16
    if (4 + countBits + byteLength * 8 <= dataCodewords(version) * 8) return version
  }
  throw new RangeError('That text is too long for this QR code.')
}

/** Mode, length, data, terminator and padding, as data codewords for `version`. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4) // byte mode
  put(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) put(byte, 8)
  const capacity = dataCodewords(version) * 8
  put(0, Math.min(4, capacity - bits.length)) // terminator
  while (bits.length % 8 !== 0) bits.push(0)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  for (let pad = 0; codewords.length < capacity / 8; pad++) codewords.push(pad % 2 === 0 ? 0xec : 0x11)
  return codewords
}

/** Splits the data into blocks, adds each block's error correction, and interleaves them as the standard lays out. */
function interleave(data: readonly number[], version: number): number[] {
  const [ec, b1, d1, b2, d2] = BLOCKS_M[version - 1] as readonly [number, number, number, number, number]
  const blocks: number[][] = []
  let at = 0
  for (let i = 0; i < b1 + b2; i++) {
    const length = i < b1 ? d1 : d2
    blocks.push(data.slice(at, at + length))
    at += length
  }
  const corrections = blocks.map((block) => errorCorrection(block, ec))
  const out: number[] = []
  for (let i = 0; i < Math.max(d1, d2); i++) for (const block of blocks) if (i < block.length) out.push(block[i] as number)
  for (let i = 0; i < ec; i++) for (const block of corrections) out.push(block[i] as number)
  return out
}

// ---------------------------------------------------------------------------------------------
// The grid

/** Error correction M with mask 0–7: the 15 format bits (BCH code, then the standard's XOR pattern). */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask // level M is 00
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** Versions 7 and up: the 18 version bits (BCH code). */
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

const MASKS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

class Grid {
  readonly size: number
  readonly dark: boolean[][]
  readonly fixed: boolean[][]

  constructor(size: number) {
    this.size = size
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  set(row: number, col: number, isDark: boolean) {
    ;(this.dark[row] as boolean[])[col] = isDark
    ;(this.fixed[row] as boolean[])[col] = true
  }

  inside(row: number, col: number) {
    return row >= 0 && col >= 0 && row < this.size && col < this.size
  }
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const { size } = grid
  // Finder patterns with their white separators.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const row = top + dr
        const col = left + dc
        if (!grid.inside(row, col)) continue
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3))
        grid.set(row, col, ring !== 2 && ring !== 4)
      }
    }
  }
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    grid.set(6, i, i % 2 === 0)
    grid.set(i, 6, i % 2 === 0)
  }
  // Alignment patterns, except where they would sit on a finder.
  const centres = ALIGNMENT[version - 1] as readonly number[]
  const last = centres.length - 1
  centres.forEach((row, i) => {
    centres.forEach((col, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) grid.set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
    })
  })
  // Reserve the format areas (filled in after the mask is chosen) and the dark module.
  drawFormat(grid, 0)
  // Version information, versions 7 and up.
  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      grid.set(b, a, bit)
      grid.set(a, b, bit)
    }
  }
}

function drawFormat(grid: Grid, mask: number) {
  const { size } = grid
  const bits = formatBits(mask)
  const bit = (i: number) => ((bits >>> i) & 1) === 1
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) grid.set(i, 8, bit(i))
  grid.set(7, 8, bit(6))
  grid.set(8, 8, bit(7))
  grid.set(8, 7, bit(8))
  for (let i = 9; i < 15; i++) grid.set(8, 14 - i, bit(i))
  // The second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) grid.set(8, size - 1 - i, bit(i))
  for (let i = 8; i < 15; i++) grid.set(size - 15 + i, 8, bit(i))
  grid.set(size - 8, 8, true) // the dark module
}

/** Places the codewords in the standard zigzag, two columns at a time from the bottom right, skipping column 6. */
function drawCodewords(grid: Grid, codewords: readonly number[]) {
  const { size } = grid
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (let j = 0; j < 2; j++) {
        const col = right - j
        if ((grid.fixed[row] as boolean[])[col]) continue
        const byte = codewords[index >>> 3]
        const isDark = byte !== undefined && ((byte >>> (7 - (index & 7))) & 1) === 1
        ;(grid.dark[row] as boolean[])[col] = isDark
        index++
      }
    }
  }
}

function applyMask(grid: Grid, mask: number) {
  const test = MASKS[mask] as (row: number, col: number) => boolean
  for (let row = 0; row < grid.size; row++) {
    for (let col = 0; col < grid.size; col++) {
      if (!(grid.fixed[row] as boolean[])[col] && test(row, col)) (grid.dark[row] as boolean[])[col] = !(grid.dark[row] as boolean[])[col]
    }
  }
}

/** The standard's penalty score: lower is easier for a scanner to read. */
export function penalty(dark: readonly (readonly boolean[])[]): number {
  const size = dark.length
  const at = (r: number, c: number) => (dark[r] as readonly boolean[])[c] as boolean
  let score = 0
  const lines: boolean[][] = []
  for (let i = 0; i < size; i++) {
    lines.push(Array.from({ length: size }, (_, j) => at(i, j)))
    lines.push(Array.from({ length: size }, (_, j) => at(j, i)))
  }
  for (const line of lines) {
    // Rule 1: five or more of the same colour in a row.
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
    // Rule 3: a finder-like pattern with four light modules on one side.
    for (let i = 0; i + 11 <= size; i++) {
      const seg = line.slice(i, i + 11).map((d) => (d ? 1 : 0)).join('')
      if (seg === '10111010000' || seg === '00001011101') score += 40
    }
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c)
      if (at(r, c + 1) === v && at(r + 1, c) === v && at(r + 1, c + 1) === v) score += 3
    }
  }
  // Rule 4: how far the share of dark modules is from half.
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs((darkCount * 100) / (size * size) - 50) / 5) * 10
  return score
}

/** The QR code for `text`, as rows of modules (true = dark). Add a 4-module light margin when drawing it. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const version = chooseVersion(bytes.length)
  const codewords = interleave(encodeData(bytes, version), version)
  let best: { score: number; dark: boolean[][] } | null = null
  for (let mask = 0; mask < MASKS.length; mask++) {
    const grid = new Grid(version * 4 + 17)
    drawFunctionPatterns(grid, version)
    drawCodewords(grid, codewords)
    applyMask(grid, mask)
    drawFormat(grid, mask)
    const score = penalty(grid.dark)
    if (!best || score < best.score) best = { score, dark: grid.dark }
  }
  return (best as { dark: boolean[][] }).dark
}

/** One SVG path for the dark modules (each a 1×1 square), offset by the light margin. */
export function qrPath(matrix: readonly (readonly boolean[])[], margin = 4): string {
  let path = ''
  matrix.forEach((row, r) => {
    row.forEach((isDark, c) => {
      if (isDark) path += `M${c + margin} ${r + margin}h1v1h-1z`
    })
  })
  return path
}
