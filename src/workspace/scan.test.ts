import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CATEGORIES } from '../ai/placeholders.ts'
import {
  boxPercent,
  brightness,
  CAMERA_MESSAGES,
  cameraProblem,
  CATEGORY_LABELS,
  fileKind,
  fitWithin,
  hiddenCountLabel,
  isPhone,
  labelBelow,
  ocrFraction,
  pageList,
  readingLabel,
  readingProgress,
  redactedFileName,
  summarize,
  tooDarkOrFlat,
  UNREADABLE_MESSAGE,
  UnreadableScanError,
  unreadablePages,
  videoConstraints,
  containRect,
  hiddenByCategory,
  liveHint,
  resultHeadline,
  stepRegion,
  textRegion,
} from './scan.ts'

const domError = (name: string) => Object.assign(new Error(name), { name })

describe('cameraProblem', () => {
  it('maps what getUserMedia throws to something the person can act on', () => {
    assert.equal(cameraProblem(domError('NotAllowedError')), 'denied')
    assert.equal(cameraProblem(domError('SecurityError')), 'denied')
    assert.equal(cameraProblem(domError('NotFoundError')), 'no-camera')
    assert.equal(cameraProblem(domError('OverconstrainedError')), 'no-camera')
    assert.equal(cameraProblem(domError('NotReadableError')), 'in-use')
    assert.equal(cameraProblem(domError('Weird')), 'other')
    assert.equal(cameraProblem('not an error'), 'other')
    assert.equal(cameraProblem(null), 'other')
  })

  it('has a message for every problem, and every one points to uploading instead', () => {
    for (const message of Object.values(CAMERA_MESSAGES)) assert.match(message.body, /upload a photo or PDF/i)
  })
})

describe('videoConstraints', () => {
  it('asks phones for the back camera, softly, so a front-only phone still works', () => {
    assert.deepEqual(videoConstraints(true).facingMode, { ideal: 'environment' })
    assert.equal(videoConstraints(false).facingMode, undefined)
  })
})

describe('isPhone', () => {
  it('trusts the browser when it says', () => {
    assert.equal(isPhone({ mobile: true, userAgent: '', coarsePointer: true }), true)
    assert.equal(isPhone({ mobile: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0)', coarsePointer: false }), false)
    assert.equal(isPhone({ mobile: false, userAgent: 'Mozilla/5.0 (Linux; Android 14)', coarsePointer: true }), true) // tablet
  })

  it('falls back to the user agent (Safari, Firefox), including iPads that call themselves a Mac', () => {
    assert.equal(isPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', coarsePointer: true }), true)
    assert.equal(isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', coarsePointer: true }), true)
    assert.equal(isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', coarsePointer: false }), false)
  })
})

describe('fileKind', () => {
  it('accepts photos and PDFs and nothing else', () => {
    assert.equal(fileKind('image/jpeg', 'a.jpg'), 'image')
    assert.equal(fileKind('image/heic', 'a.heic'), 'image')
    assert.equal(fileKind('application/pdf', 'a.pdf'), 'pdf')
    assert.equal(fileKind('', 'Scan.PDF'), 'pdf')
    assert.equal(fileKind('', 'photo.jpeg'), 'image')
    assert.equal(fileKind('text/plain', 'notes.txt'), 'unsupported')
    assert.equal(fileKind('', 'notes.docx'), 'unsupported')
    assert.equal(fileKind('text/plain', 'trick.pdf'), 'unsupported') // a real type wins over the name
  })
})

describe('fitWithin', () => {
  it('scales down to the long side, keeps the shape, and never scales up', () => {
    assert.deepEqual(fitWithin(4800, 3600, 2400), { width: 2400, height: 1800 })
    assert.deepEqual(fitWithin(3000, 6000, 2400), { width: 1200, height: 2400 })
    assert.deepEqual(fitWithin(800, 600, 2400), { width: 800, height: 600 })
    assert.deepEqual(fitWithin(0, 0, 2400), { width: 1, height: 1 })
  })
})

describe('brightness and tooDarkOrFlat', () => {
  const fill = (pixels: number[][]) => pixels.flatMap(([r, g, b]) => [r ?? 0, g ?? 0, b ?? 0, 255])

  it('calls a black frame and a blank wall unreadable, and a page of text readable', () => {
    assert.equal(tooDarkOrFlat(brightness(fill(Array(100).fill([5, 5, 5])))), true)
    assert.equal(tooDarkOrFlat(brightness(fill(Array(100).fill([200, 200, 200])))), true)
    const text = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? [30, 30, 30] : [240, 240, 240]))
    assert.equal(tooDarkOrFlat(brightness(fill(text))), false)
  })

  it('handles no pixels', () => {
    assert.deepEqual(brightness([]), { mean: 0, spread: 0 })
  })
})

describe('reading progress', () => {
  it('runs once across every page and never goes past 1', () => {
    assert.equal(readingProgress(0, 1, 0.5), 0.5)
    assert.equal(readingProgress(1, 4, 0), 0.25)
    assert.equal(readingProgress(3, 4, 1), 1)
    assert.equal(readingProgress(9, 4, 2), 1)
    assert.equal(readingProgress(0, 2, 0, 0.2), 0.2) // PDFs start after the share spent opening the file
  })

  it('splits one page between starting the OCR engine and reading', () => {
    assert.equal(ocrFraction({ stage: 'loading', fraction: 0 }), 0)
    assert.equal(ocrFraction({ stage: 'loading', fraction: 1 }), 0.3)
    assert.equal(ocrFraction({ stage: 'reading', fraction: 0 }), 0.3)
    assert.equal(ocrFraction({ stage: 'reading', fraction: 1 }), 1)
    assert.equal(ocrFraction({ stage: 'reading', fraction: Number.NaN }), 0.3)
    assert.equal(ocrFraction({ stage: 'reading', fraction: 5 }), 1)
  })

  it('names the page only when there is more than one', () => {
    assert.equal(readingLabel(0, 1), 'Reading text…')
    assert.equal(readingLabel(1, 3), 'Reading page 2 of 3…')
  })
})

describe('boxes', () => {
  it('places a box in percent of the picture, clamped to its edges', () => {
    assert.deepEqual(boxPercent({ x: 100, y: 50, width: 200, height: 25 }, 1000, 500), {
      left: '10%',
      top: '10%',
      width: '20%',
      height: '5%',
    })
    assert.deepEqual(boxPercent({ x: -10, y: 480, width: 50, height: 40 }, 1000, 500), {
      left: '0%',
      top: '96%',
      width: '4%',
      height: '4%',
    })
  })

  it('shows the label below a box at the very top', () => {
    assert.equal(labelBelow({ x: 0, y: 10, width: 10, height: 10 }, 1000), true)
    assert.equal(labelBelow({ x: 0, y: 500, width: 10, height: 10 }, 1000), false)
  })

  it('has a label for every category', () => {
    for (const category of CATEGORIES) assert.ok(CATEGORY_LABELS[category], category)
  })

  it('summarizes by label, most first', () => {
    const at = { x: 0, y: 0, width: 1, height: 1 }
    assert.deepEqual(
      summarize([
        { ...at, category: 'MEDICAL' },
        { ...at, category: 'PERSON' },
        { ...at, category: 'PERSON' },
        { ...at, category: 'EMPLOYEE_ID' },
      ]),
      [
        { label: 'Name', count: 2 },
        { label: 'Employee ID', count: 1 },
        { label: 'Medical detail', count: 1 },
      ],
    )
    assert.equal(hiddenCountLabel(0), 'Nothing hidden')
    assert.equal(hiddenCountLabel(3), '3 hidden')
  })
})

describe('pages', () => {
  it('lists the pages that could not be read', () => {
    assert.deepEqual(unreadablePages([{ unreadable: false }, { unreadable: true }, { unreadable: true }]), [2, 3])
    assert.equal(pageList([2]), 'page 2')
    assert.equal(pageList([2, 4]), 'pages 2 and 4')
    assert.equal(pageList([1, 3, 5]), 'pages 1, 3 and 5')
  })

  it('names the download after the file', () => {
    assert.equal(redactedFileName('case notes.pdf', 'pdf'), 'case-notes-redacted.pdf')
    assert.equal(redactedFileName('IMG_0042.HEIC', 'png'), 'IMG_0042-redacted.png')
    assert.equal(redactedFileName(null, 'png'), 'scan-redacted.png')
    assert.equal(redactedFileName('...', 'pdf'), 'scan-redacted.pdf')
  })
})

describe('UnreadableScanError', () => {
  it('carries the one unreadable message', () => {
    const error = new UnreadableScanError()
    assert.equal(error.name, 'UnreadableScanError')
    assert.equal(error.message, UNREADABLE_MESSAGE)
    assert.equal(UNREADABLE_MESSAGE, 'We couldn’t read this clearly enough to hide the private details. Hold the page flat and close, in good light.')
  })
})

describe('live preview', () => {
  it('finds where a contained picture sits in its frame', () => {
    // A 16:9 camera in a 4:3 frame: full width, bars above and below.
    assert.deepEqual(containRect({ width: 800, height: 600 }, { width: 1280, height: 720 }), {
      left: '0%',
      top: '12.5%',
      width: '100%',
      height: '75%',
    })
    // A tall (portrait) camera: full height, bars at the sides.
    assert.deepEqual(containRect({ width: 800, height: 600 }, { width: 720, height: 1280 }), {
      left: '28.91%',
      top: '0%',
      width: '42.19%',
      height: '100%',
    })
  })

  it('says one plain line for each state', () => {
    assert.equal(liveHint({ kind: 'no-text' }), 'Point the camera at the page.')
    const line = { x: 0, y: 0, width: 1, height: 1 }
    assert.match(liveHint({ kind: 'text', lines: [line], width: 1, height: 1, unclear: false }), /^All text is blurred/)
    assert.match(liveHint({ kind: 'text', lines: [line], width: 1, height: 1, unclear: true }), /Move closer/)
  })
})

describe('result screen', () => {
  it('counts hidden details per category, most first', () => {
    const box = (category: 'PERSON' | 'PHONE' | 'EMAIL') => ({ x: 0, y: 0, width: 1, height: 1, category })
    assert.deepEqual(hiddenByCategory([box('PHONE'), box('PERSON'), box('PERSON'), box('EMAIL')]), [
      { category: 'PERSON', label: 'Name', count: 2 },
      { category: 'EMAIL', label: 'Email', count: 1 },
      { category: 'PHONE', label: 'Phone', count: 1 },
    ])
    assert.deepEqual(hiddenByCategory([]), [])
  })

  it('leads with the outcome', () => {
    const base = { hidden: 3, pages: 1, noCopy: false, unclear: false }
    assert.equal(resultHeadline(base).title, '3 details blacked out')
    assert.equal(resultHeadline({ ...base, hidden: 1 }).title, '1 detail blacked out')
    assert.equal(resultHeadline({ ...base, pages: 3 }).title, '3 details blacked out across 3 pages')
    assert.equal(resultHeadline({ ...base, hidden: 0 }).title, 'Nothing private found')
    assert.equal(resultHeadline({ ...base, unclear: true }).title, 'Check this copy before you share it')
    assert.equal(resultHeadline({ ...base, noCopy: true, unclear: true }).title, 'No safe copy yet')
  })
})

describe('frosted pane', () => {
  it('covers every line with one padded region, in fractions of the picture', () => {
    const lines = [
      { x: 100, y: 50, width: 300, height: 20 },
      { x: 80, y: 90, width: 500, height: 20 },
    ]
    const r = textRegion(lines, { width: 1000, height: 500 }, 0.02)
    assert.ok(r)
    assert.equal(r.x.toFixed(3), '0.060')
    assert.equal(r.y.toFixed(3), '0.080')
    assert.equal((r.x + r.width).toFixed(3), '0.600')
    assert.equal((r.y + r.height).toFixed(3), '0.240')
    assert.equal(textRegion([], { width: 1000, height: 500 }), null)
  })

  it('grows fast and shrinks slowly, edge by edge', () => {
    const now = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }
    // The target is wider on the left (grow) and shorter at the bottom (shrink).
    const target = { x: 0.1, y: 0.3, width: 0.6, height: 0.2 }
    const next = stepRegion(now, target, 50)
    const leftMoved = now.x - next.x
    const bottomMoved = now.y + now.height - (next.y + next.height)
    assert.ok(leftMoved > 0 && bottomMoved > 0)
    assert.ok(leftMoved / 0.2 > 3 * (bottomMoved / 0.2), 'the growing edge covers ground several times faster')
    // Given time, it arrives.
    let r = now
    for (let i = 0; i < 200; i++) r = stepRegion(r, target, 16)
    assert.ok(Math.abs(r.x - 0.1) < 1e-3 && Math.abs(r.y + r.height - 0.5) < 1e-3)
  })
})
