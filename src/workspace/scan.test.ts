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
  blockedMessage,
  browserAdvice,
  cameraChoices,
  autoProgress,
  containRect,
  HEIC_MESSAGE,
  PDF_LONG_SIDE,
  PDF_MAX_PAGES,
  PdfScanError,
  pdfProblem,
  pdfScale,
  isHeic,
  loadAutoCapture,
  saveAutoCapture,
  stepAutoCapture,
  AUTO_HOLD_MS,
  AUTO_IDLE,
  draftTextFromOcr,
  isChromeBrowser,
  loadCameraId,
  platformOf,
  saveCameraId,
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

describe('browser and cameras', () => {
  it('tells Chrome apart from other Chromium browsers', () => {
    assert.equal(isChromeBrowser({ brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }], userAgent: '' }), true)
    assert.equal(isChromeBrowser({ brands: [{ brand: 'Brave' }, { brand: 'Chromium' }], userAgent: '' }), false)
    assert.equal(isChromeBrowser({ brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }], userAgent: '' }), false)
    assert.equal(isChromeBrowser({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18 Safari/605' }), false)
    assert.equal(isChromeBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537' }), true)
    assert.equal(isChromeBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537 Edg/150.0' }), false)
  })

  it('finds the computer type', () => {
    assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac')
    assert.equal(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows')
    assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'other')
    assert.equal(platformOf('', 'macOS'), 'mac')
  })

  it('advises only when the setup is less safe than Chrome with the private AI', () => {
    assert.equal(browserAdvice({ chrome: true, phone: false, privateAi: true }), null)
    assert.equal(browserAdvice({ chrome: true, phone: false, privateAi: null }), null)
    assert.equal(browserAdvice({ chrome: false, phone: false, privateAi: null })?.title, 'For the safest photos, use Chrome')
    assert.equal(browserAdvice({ chrome: false, phone: false, privateAi: false })?.copyLink, true)
    assert.equal(browserAdvice({ chrome: true, phone: true, privateAi: false })?.phoneTip, true)
    assert.equal(browserAdvice({ chrome: true, phone: false, privateAi: false })?.title, 'This laptop gets basic checks')
  })

  it('lists cameras once each, marks phones, and labels unnamed ones', () => {
    const choices = cameraChoices([
      { kind: 'videoinput', deviceId: 'a', label: 'FaceTime HD Camera' },
      { kind: 'audioinput', deviceId: 'm', label: 'Microphone' },
      { kind: 'videoinput', deviceId: 'b', label: 'Desk View Camera' },
      { kind: 'videoinput', deviceId: 'c', label: 'iPhone Camera' },
      { kind: 'videoinput', deviceId: 'c', label: 'iPhone Camera' },
      { kind: 'videoinput', deviceId: 'd', label: '' },
    ])
    assert.deepEqual(choices, [
      { id: 'a', label: 'FaceTime HD Camera', phone: false },
      { id: 'b', label: 'Desk View Camera (phone)', phone: true },
      { id: 'c', label: 'iPhone Camera', phone: true },
      { id: 'd', label: 'Camera 4', phone: false },
    ])
  })

  it('remembers the chosen camera, and blocked storage never breaks the page', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    assert.equal(loadCameraId(storage), null)
    saveCameraId('cam-1', storage)
    assert.equal(loadCameraId(storage), 'cam-1')
    const blocked = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    assert.equal(loadCameraId(blocked), null)
    assert.doesNotThrow(() => saveCameraId('x', blocked))
  })
})

describe('blocked pages', () => {
  it('says why a page got no copy, without naming the detail', () => {
    assert.match(blockedMessage('redaction-blocked'), /couldn’t hide safely/)
    assert.match(blockedMessage('unplaced'), /couldn’t be matched to a spot/)
    assert.match(blockedMessage('image-mismatch'), /didn’t line up/)
  })
})

describe('text for drafting', () => {
  // FAKE DATA. Words laid out by line, with confidence, like OCR output.
  const ocr = (lines: Array<Array<[string, number]>>) => ({
    text: '',
    words: lines.flatMap((line, row) => line.map(([text, confidence], i) => ({ text, confidence, line: row, x: i * 50, y: row * 30, w: 40, h: 20 }))),
  })

  it('drops symbol scraps and unsure fragments, keeps real words and meaningful dashes', () => {
    const out = draftTextFromOcr(
      ocr([
        [['|', 40]],
        [['ahi', 30], ['Date:', 95], ['Mon,', 96], ['Nov', 97], ['16', 96]],
        [['RE:', 95], ['missed', 96], ['—', 90], ['deadlines', 95], ['=', 30], ['~', 20]],
        [['¢', 30], ['That', 96], ['may', 95], ['be', 96], ['relevant.', 94]],
        [['a', 35], ['ees', 30]],
      ]),
    )
    assert.equal(out, 'Date: Mon, Nov 16\nRE: missed — deadlines\nThat may be relevant.')
  })

  it('reads a lone "|" before a lowercase word as "I", joins wrapped lines, and closes the email gap', () => {
    const out = draftTextFromOcr(
      ocr([
        [['Hi', 96], ['team,', 95], ['|', 80], ['looked', 96], ['at', 96], ['the', 96]],
        [['sprint', 95], ['reports', 96], ['you', 96], ['sent.', 95]],
        [['Write', 96], ['to', 96], ['jo.example', 92], ['@example.com', 90]],
      ]),
    )
    assert.equal(out, 'Hi team, I looked at the sprint reports you sent.\nWrite to jo.example@example.com')
  })

  it('never adds words that weren’t on the page', () => {
    const source = ocr([[['Riley', 96], ['Sample', 95], ['xq', 20], ['called.', 96]]])
    const out = draftTextFromOcr(source)
    for (const word of out.split(/\s+/)) assert.ok(source.words.some((w) => w.text === word), word)
  })
})

describe('uploads', () => {
  it('spots iPhone HEIC photos by type or name', () => {
    assert.equal(isHeic('image/heic', 'a.jpg'), true)
    assert.equal(isHeic('', 'IMG_0042.HEIC'), true)
    assert.equal(isHeic('image/heif', ''), true)
    assert.equal(isHeic('image/jpeg', 'a.jpg'), false)
    assert.match(HEIC_MESSAGE, /JPEG/)
  })
})

describe('auto-capture', () => {
  const view = (dx = 0, unclear = false) => ({
    kind: 'text' as const,
    lines: [{ x: 100 + dx, y: 100, width: 600, height: 40 }, { x: 100 + dx, y: 160, width: 600, height: 40 }],
    width: 1000,
    height: 800,
    unclear,
  })

  it('holds while the page stays put, and reaches 1 after the hold', () => {
    let state = stepAutoCapture(AUTO_IDLE, view(), 1000)
    assert.equal(state.since, 1000)
    state = stepAutoCapture(state, view(5), 1600) // moved a little: still steady
    assert.equal(state.since, 1000)
    assert.equal(autoProgress(state, 1600, 1600), 0.4)
    assert.equal(autoProgress(state, 1000 + AUTO_HOLD_MS, 1000 + AUTO_HOLD_MS), 1)
  })

  it('resets when the page moves a lot, gets hard to read, or disappears', () => {
    const start = stepAutoCapture(stepAutoCapture(AUTO_IDLE, view(), 1000), view(), 1500)
    assert.equal(stepAutoCapture(start, view(200), 2000).since, 2000, 'a big move restarts the hold')
    assert.deepEqual(stepAutoCapture(start, view(0, true), 2000), AUTO_IDLE)
    assert.deepEqual(stepAutoCapture(start, { kind: 'no-text' }, 2000), AUTO_IDLE)
  })

  it('counts a stale look as no progress', () => {
    const state = stepAutoCapture(stepAutoCapture(AUTO_IDLE, view(), 1000), view(), 1500)
    assert.equal(autoProgress(state, 9000, 1500), 0)
  })

  it('is on unless turned off, remembered per browser, and blocked storage never breaks it', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    assert.equal(loadAutoCapture(storage), true)
    saveAutoCapture(false, storage)
    assert.equal(loadAutoCapture(storage), false)
    saveAutoCapture(true, storage)
    assert.equal(loadAutoCapture(storage), true)
    const blocked = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    assert.equal(loadAutoCapture(blocked), true)
    assert.doesNotThrow(() => saveAutoCapture(false, blocked))
  })
})

describe('PDF pages', () => {
  it('draws a Letter page at about 150 dpi, never smaller than the PDF itself', () => {
    const scale = pdfScale(612, 792)
    assert.ok(Math.abs(792 * scale - PDF_LONG_SIDE) < 1)
    assert.equal(pdfScale(4000, 3000), 1, 'a page already bigger than the target is not shrunk below 1')
  })

  it('says why a PDF could not be opened', () => {
    assert.match(pdfProblem(new PdfScanError('password')).title, /password protected/)
    const long = pdfProblem(new PdfScanError('too-many-pages', 80))
    assert.match(long.message, /80 pages/)
    assert.match(long.message, new RegExp(`${PDF_MAX_PAGES} at a time`))
    assert.match(pdfProblem(new Error('anything else')).title, /couldn’t open/)
  })
})
