import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { downloadBlob } from '../download.ts'
import { LoadingCard } from './components.tsx'
import { ScanIcon, WhereChip } from './icons.tsx'
import {
  boxPercent,
  CAMERA_MESSAGES,
  containRect,
  cameraProblem,
  CATEGORY_LABELS,
  fileKind,
  fitWithin,
  hiddenCountLabel,
  isPhone,
  labelBelow,
  liveHint,
  ocrFraction,
  pageList,
  readingLabel,
  readingProgress,
  redactedFileName,
  summarize,
  UNREADABLE_MESSAGE,
  UNSUPPORTED_FILE_MESSAGE,
  unreadablePages,
  videoConstraints,
} from './scan.ts'
import type { CameraProblem, LiveView, Rect, ScanBox } from './scan.ts'
import { blackOut, pagesToPdf, PDF_DEMO, pdfToPages, previewBoxes, readText } from './scanAi.ts'

// "Scan a document": take a photo or upload a photo or PDF, read the text ON THIS DEVICE, and show the original
// next to a blacked-out copy. Pictures live in this tab's memory only (canvases and blob: URLs, freed on leaving).
// The camera is on only while the capture view is showing.

const BLOCKED_MESSAGE =
  'A private detail couldn’t be matched to a spot on the picture, so no copy was made. Try again, flatter and in better light.'

/** Long side of a picture we read. Bigger photos take longer and read no better. */
const MAX_SIDE = 2400
/** Long side of a live preview frame: smaller than a photo, so each look takes a second or two, not five. */
const LIVE_SIDE = 1280
/** Rest between live looks, so a slow laptop isn't kept at full speed. */
const LIVE_PAUSE_MS = 700

/** Share of the progress bar spent turning PDF pages into pictures. */
const PDF_RENDER_SHARE = 0.15

interface ScannedPage {
  width: number
  height: number
  originalUrl: string
  /** Null when the page couldn't be read or blacked out safely: there is no safe copy of it. */
  redacted: { canvas: HTMLCanvasElement; blob: Blob; url: string } | null
  /** True when the text was read but a private detail couldn't be placed on the picture (so no copy was made). */
  blocked: boolean
  boxes: ScanBox[]
  /** Words read with low confidence, outlined so the person checks them. */
  review: Rect[]
}

type Phase =
  | { kind: 'capture' }
  | { kind: 'reading'; progress: number; label: string }
  | { kind: 'problem'; title: string; message: string }
  | { kind: 'result'; source: 'photo' | 'pdf'; fileName: string | null; pages: ScannedPage[] }

type CameraState = { status: 'starting' | 'live' } | { status: 'problem'; problem: CameraProblem }

function onPhone(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  return isPhone({
    mobile: nav.userAgentData?.mobile,
    userAgent: nav.userAgent,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
  })
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop()
}

function show(video: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!video || video.srcObject === stream) return
  video.srcObject = stream
  if (stream) void video.play().catch(() => undefined) // muted + playsInline, so autoplay is allowed
}

/** Browsers only offer the camera on secure pages, so a phone on a plain http:// address has none either. */
const cameraApi = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'

/**
 * Runs the camera while the component using it is on screen, and turns it off (the light goes out) when it
 * leaves. `retry` asks again after a problem.
 */
function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>(() =>
    cameraApi() ? { status: 'starting' } : { status: 'problem', problem: 'unsupported' },
  )
  const [attempt, setAttempt] = useState(0)

  // A callback ref, because the <video> comes and goes (it isn't shown while there's a camera problem).
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element
    show(element, streamRef.current)
  }, [])

  useEffect(() => {
    if (!cameraApi()) return
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: videoConstraints(onPhone()), audio: false })
      .then((media) => {
        if (cancelled) return stopStream(media) // left the screen while the browser was asking
        streamRef.current = media
        media.getVideoTracks()[0]?.addEventListener('ended', () => setState({ status: 'problem', problem: 'other' }))
        show(videoRef.current, media)
        setState({ status: 'live' })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'problem', problem: cameraProblem(error) })
      })

    return () => {
      cancelled = true
      if (streamRef.current) stopStream(streamRef.current)
      streamRef.current = null
      show(videoRef.current, null)
    }
  }, [attempt])

  function retry() {
    setState(cameraApi() ? { status: 'starting' } : { status: 'problem', problem: 'unsupported' })
    setAttempt((n) => n + 1)
  }

  return { videoRef, attachVideo, state, retry }
}

interface CaptureViewProps {
  onBack: () => void
  onPhoto: (page: HTMLCanvasElement) => void
  onFile: (file: File) => void
  fileError: string | null
}

/**
 * While the camera is live: every second or two, reads one frame and finds the private details in it (on this
 * device, basic engine), so they can be blurred on the preview. One look at a time; paused while the tab is hidden;
 * stops when the preview goes away. A preview only: the photo gets its own full check.
 */
function useLiveView(videoRef: RefObject<HTMLVideoElement | null>, active: boolean): LiveView {
  const [view, setView] = useState<LiveView>({ kind: 'starting' })

  useEffect(() => {
    if (!active) return
    let stopped = false
    const rest = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

    async function look() {
      while (!stopped) {
        const video = videoRef.current
        if (document.hidden || !video || !video.videoWidth) {
          await rest(500)
          continue
        }
        try {
          const size = fitWithin(video.videoWidth, video.videoHeight, LIVE_SIDE)
          const frame = canvasOf(size.width, size.height)
          frame.getContext('2d')?.drawImage(video, 0, 0, size.width, size.height)
          const ocr = await readText(frame)
          if (stopped) return
          const seen = await previewBoxes(frame, ocr)
          if (!stopped) setView(seen)
        } catch {
          if (!stopped) setView({ kind: 'no-text' }) // a look that fails just tries again; the photo is unaffected
        }
        await rest(LIVE_PAUSE_MS)
      }
    }
    void look()
    return () => {
      stopped = true
    }
  }, [active, videoRef])

  return view
}

/** The camera preview plus "Upload a photo or PDF". The camera runs only while this is on screen. */
function CaptureView({ onBack, onPhoto, onFile, fileError }: CaptureViewProps) {
  const { videoRef, attachVideo, state, retry } = useCamera()
  const [videoReady, setVideoReady] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const problem = state.status === 'problem' ? CAMERA_MESSAGES[state.problem] : null
  const canShoot = state.status === 'live' && videoReady
  const live = useLiveView(videoRef, canShoot)
  const [frameBox, setFrameBox] = useState<{ width: number; height: number } | null>(null)
  // The preview frame's size, kept current, so the outlines line up with the picture at any window size.
  const watchFrame = useCallback((element: HTMLDivElement | null) => {
    if (!element) return
    const measure = () => setFrameBox({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function takePhoto() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    onPhoto(drawScaled(video, video.videoWidth, video.videoHeight))
  }

  return (
    <section className="card scan" aria-labelledby="scan-title">
      <WhereChip where="laptop">On this device</WhereChip>
      <h2 id="scan-title" tabIndex={-1} className="scan-title">
        Scan a document
      </h2>
      <p className="muted">Hold the page flat in good light. Cloak reads it on this device and blacks out the private details.</p>

      {problem ? (
        <div className="notice warn scan-camera-problem" role="alert">
          <p>
            <strong>{problem.title}</strong>
          </p>
          <p>{problem.body}</p>
          {problem.retry && (
            <button type="button" className="mini-btn" onClick={retry}>
              Try the camera again
            </button>
          )}
        </div>
      ) : (
        <div className="scan-camera" ref={watchFrame}>
          <video
            ref={attachVideo}
            muted
            playsInline
            autoPlay
            aria-label="Camera preview"
            onLoadedData={() => setVideoReady(true)}
            onEmptied={() => setVideoReady(false)}
          />
          {canShoot && live.kind === 'found' && frameBox && (
            // Blurred patches where the private details are, on top of the picture (not the letterbox bars).
            <div className="scan-live" style={containRect(frameBox, live)} aria-hidden="true">
              {live.boxes.map((box, index) => (
                <span key={`${box.x}-${box.y}-${index}`} className="scan-live-box" style={boxPercent(box, live.width, live.height)} />
              ))}
            </div>
          )}
          {canShoot ? (
            <span className="scan-guide" aria-hidden="true" />
          ) : (
            <span className="scan-camera-status" role="status">
              <span className="loading-ring" aria-hidden="true" />
              Starting the camera…
            </span>
          )}
        </div>
      )}

      {!problem && canShoot && (
        <p className={`scan-live-hint${live.kind === 'hard-to-read' ? ' is-warn' : ''}`} role="status" aria-live="polite">
          {liveHint(live)}
        </p>
      )}

      {fileError && (
        <p className="notice warn" role="alert">
          {fileError}
        </p>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = '' // so choosing the same file again still works
          if (file) onFile(file)
        }}
      />

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className={problem ? 'btn btn-primary' : 'btn btn-quiet'} onClick={() => fileInput.current?.click()}>
          Upload a photo or PDF
        </button>
        {!problem && (
          <button type="button" className="btn btn-primary" onClick={takePhoto} disabled={!canShoot}>
            Take photo
          </button>
        )}
      </div>
    </section>
  )
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not save the picture.'))), 'image/png'),
  )
}

/** Draws any picture onto a new canvas, scaled down to MAX_SIDE. */
function drawScaled(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const size = fitWithin(width, height, MAX_SIDE)
  const canvas = canvasOf(size.width, size.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is not available.')
  ctx.drawImage(source, 0, 0, size.width, size.height)
  return canvas
}

interface StepScanProps {
  onBack: () => void
}

export function StepScan({ onBack }: StepScanProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'capture' })
  const [fileError, setFileError] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [active, setActive] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Every blob: URL made for this scan, freed on "Scan another" and when leaving the screen.
  const urls = useRef<string[]>([])
  // Bumped to ignore a read that is still running (on leaving, or on starting again).
  const run = useRef(0)

  const freeUrls = useCallback(() => {
    for (const url of urls.current) URL.revokeObjectURL(url)
    urls.current = []
  }, [])

  useEffect(
    () => () => {
      run.current++
      freeUrls()
    },
    [freeUrls],
  )

  // Move focus to the new heading when the view changes, so keyboard and screen reader users land on it.
  const firstPhase = useRef(true)
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false
      return
    }
    document.getElementById('scan-title')?.focus()
  }, [phase.kind])

  function makeUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob)
    urls.current.push(url)
    return url
  }

  function showProblem(title: string, message: string) {
    setPhase({ kind: 'problem', title, message })
  }

  /** Reads every page, blacks out what it finds, and shows the result. */
  async function readPages(pages: HTMLCanvasElement[], source: 'photo' | 'pdf', fileName: string | null) {
    const id = ++run.current
    const share = source === 'pdf' ? PDF_RENDER_SHARE : 0
    const still = () => run.current === id

    const scanned: ScannedPage[] = []
    try {
      for (const [index, page] of pages.entries()) {
        if (!still()) return
        setPhase({ kind: 'reading', progress: readingProgress(index, pages.length, 0, share), label: readingLabel(index, pages.length) })
        const original = makeUrl(await toBlob(page))
        let ocr
        try {
          ocr = await readText(page, {
            onProgress: (progress) => {
              if (still())
                setPhase({
                  kind: 'reading',
                  progress: readingProgress(index, pages.length, ocrFraction(progress), share),
                  label: readingLabel(index, pages.length),
                })
            },
          })
        } catch {
          if (!still()) return
          // Any reading failure is shown the same way: too dark, blurry, blank or not a document.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, boxes: [], review: [] })
          continue
        }
        if (!still()) return
        if (ocr.words.length === 0) {
          // The reader ran but found no text: a blank, blurry or too-dark shot.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, boxes: [], review: [] })
          continue
        }
        setPhase({ kind: 'reading', progress: readingProgress(index, pages.length, 1, share), label: 'Finding private details…' })
        const result = await blackOut(page, ocr)
        if (!still()) return
        if (result.status === 'unreadable') {
          // Too much was read unclearly to find the private details: shown like any page we couldn't read.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, boxes: [], review: [] })
          continue
        }
        if (result.status === 'blocked') {
          // Fail closed: no copy at all rather than one that might show a detail.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: true, boxes: [], review: [] })
          continue
        }
        const blob = await toBlob(result.redacted)
        scanned.push({
          width: page.width,
          height: page.height,
          originalUrl: original,
          redacted: { canvas: result.redacted, blob, url: makeUrl(blob) },
          blocked: false,
          boxes: result.boxes,
          review: result.review,
        })
      }
    } catch {
      if (still()) showProblem('Something went wrong', 'Something went wrong on this device. Nothing was sent anywhere. Please try again.')
      return
    }
    if (!still()) return

    if (scanned.every((page) => page.redacted === null)) {
      freeUrls()
      if (scanned.some((page) => page.blocked)) showProblem('We couldn’t black this out safely', BLOCKED_MESSAGE)
      else showProblem('We couldn’t read this', UNREADABLE_MESSAGE)
      return
    }
    setCurrent(0)
    setActive(null)
    setPhase({ kind: 'result', source, fileName, pages: scanned })
  }

  async function openFile(file: File) {
    setFileError(null)
    const kind = fileKind(file.type, file.name)
    if (kind === 'unsupported') {
      setFileError(UNSUPPORTED_FILE_MESSAGE)
      return
    }

    if (kind === 'image') {
      let page: HTMLCanvasElement
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
        page = drawScaled(bitmap, bitmap.width, bitmap.height)
        bitmap.close()
      } catch {
        showProblem('We couldn’t read this', UNREADABLE_MESSAGE) // damaged, or a format this browser can't open
        return
      }
      void readPages([page], 'photo', file.name)
      return
    }

    const id = ++run.current
    setPhase({ kind: 'reading', progress: 0, label: 'Opening the PDF…' })
    let pages: HTMLCanvasElement[]
    try {
      pages = await pdfToPages(file, (fraction) => {
        if (run.current === id) setPhase({ kind: 'reading', progress: fraction * PDF_RENDER_SHARE, label: 'Opening the PDF…' })
      })
    } catch {
      if (run.current === id) showProblem('We couldn’t open this PDF', 'It may be damaged or protected with a password. Try another file, or take a photo of the page instead.')
      return
    }
    if (run.current !== id) return
    if (pages.length === 0) {
      showProblem('This PDF has no pages', 'Try another file, or take a photo of the page instead.')
      return
    }
    void readPages(pages, 'pdf', file.name)
  }

  function scanAnother() {
    run.current++
    freeUrls()
    setFileError(null)
    setSaveError(null)
    setPhase({ kind: 'capture' })
  }

  async function download() {
    if (phase.kind !== 'result') return
    setSaving(true)
    setSaveError(null)
    try {
      if (phase.source === 'pdf') {
        const canvases = phase.pages.map((page) => page.redacted?.canvas)
        if (canvases.some((canvas) => !canvas)) return // never: the button is off while a page is unreadable
        downloadBlob(redactedFileName(phase.fileName, 'pdf'), await pagesToPdf(canvases as HTMLCanvasElement[]))
      } else {
        const blob = phase.pages[0]?.redacted?.blob
        if (blob) downloadBlob(redactedFileName(phase.fileName, 'png'), blob)
      }
    } catch {
      setSaveError('We couldn’t make the file. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // ---------- Reading ----------

  if (phase.kind === 'reading') {
    return (
      <LoadingCard
        title="Reading text on your device…"
        note="Your document isn’t leaving this device."
        checks={['Reading the words', 'Finding private details', 'Blacking them out']}
        where="laptop"
        whereText="On this device"
        progress={phase.progress}
        progressLabel={phase.label}
      />
    )
  }

  // ---------- Couldn't read / couldn't open ----------

  if (phase.kind === 'problem') {
    return (
      <section className="card empty" aria-labelledby="scan-title">
        <span className="choice-icon is-peach" aria-hidden="true">
          <ScanIcon size={28} />
        </span>
        <h2 id="scan-title" tabIndex={-1}>
          {phase.title}
        </h2>
        <p className="muted" role="alert">
          {phase.message}
        </p>
        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onBack}>
            Back
          </button>
          <button type="button" className="btn btn-primary" onClick={scanAnother}>
            Try again
          </button>
        </div>
      </section>
    )
  }

  // ---------- Result ----------

  if (phase.kind === 'result') {
    const pages = phase.pages
    const page = pages[Math.min(current, pages.length - 1)]
    if (!page) return null
    const missing = unreadablePages(pages.map((p) => ({ unreadable: p.redacted === null })))
    const unreadable = unreadablePages(pages.map((p) => ({ unreadable: p.redacted === null && !p.blocked })))
    const blocked = unreadablePages(pages.map((p) => ({ unreadable: p.blocked })))
    const toCheck = pages.reduce((sum, p) => sum + p.review.length, 0)
    const totalHidden = pages.reduce((sum, p) => sum + p.boxes.length, 0)
    const summary = summarize(page.boxes)
    const activeBox = active === null ? null : page.boxes[active]
    const isPdf = phase.source === 'pdf'

    const clearOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Escape') event.currentTarget.blur()
    }

    return (
      <section className="card scan" aria-labelledby="scan-title">
        <WhereChip where="laptop">On this device</WhereChip>
        <h2 id="scan-title" tabIndex={-1} className="scan-title">
          Check the blacked-out copy
        </h2>
        <p className="muted">
          {totalHidden === 0
            ? 'We didn’t find any private details. Check the page yourself before you share it.'
            : `${totalHidden} ${totalHidden === 1 ? 'detail is' : 'details are'} blacked out${isPdf ? ` across ${pages.length} pages` : ''}. Hover over or tap a box to see what it hides.`}
        </p>

        {isPdf && PDF_DEMO && (
          <p className="notice info">Demo: opening PDFs isn’t connected yet, so these are made-up sample pages, read and blacked out for real.</p>
        )}

        {isPdf && (
          <ol className="scan-pages" aria-label="Pages">
            {pages.map((p, index) => (
              <li key={p.originalUrl}>
                <button
                  type="button"
                  className="scan-page"
                  aria-current={index === current ? 'true' : undefined}
                  onClick={() => {
                    setCurrent(index)
                    setActive(null)
                  }}
                >
                  <span className="scan-thumb" aria-hidden="true">
                    {p.redacted ? <img src={p.redacted.url} alt="" /> : <span className="scan-thumb-missing">?</span>}
                  </span>
                  <span className="scan-page-text">
                    <span className="scan-page-name">Page {index + 1}</span>
                    <span className={p.redacted ? 'scan-page-count' : 'scan-page-count is-warn'}>
                      {p.redacted ? hiddenCountLabel(p.boxes.length) : p.blocked ? 'Not safe' : 'Couldn’t read'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="scan-compare">
          <figure className="scan-figure">
            <figcaption>Original{isPdf ? `, page ${current + 1}` : ''}</figcaption>
            <div className="scan-frame">
              <img src={page.originalUrl} width={page.width} height={page.height} alt={`Original${isPdf ? ` page ${current + 1}` : ' photo'}`} />
              {activeBox && <span className="scan-mark" style={boxPercent(activeBox, page.width, page.height)} aria-hidden="true" />}
            </div>
          </figure>

          <figure className="scan-figure is-redacted">
            <figcaption>
              Blacked out · {page.redacted ? hiddenCountLabel(page.boxes.length) : page.blocked ? 'not safe to share' : 'couldn’t read'}
            </figcaption>
            {page.redacted ? (
              <div className="scan-frame">
                <img
                  src={page.redacted.url}
                  width={page.width}
                  height={page.height}
                  alt={`Blacked-out copy${isPdf ? ` of page ${current + 1}` : ''}, ${hiddenCountLabel(page.boxes.length).toLowerCase()}`}
                />
                {page.review.map((spot) => (
                  <span key={`review-${spot.x}-${spot.y}`} className="scan-review" style={boxPercent(spot, page.width, page.height)} aria-hidden="true" />
                ))}
                {page.boxes.map((box, index) => {
                  const label = CATEGORY_LABELS[box.category]
                  return (
                    <button
                      key={`${box.x}-${box.y}-${index}`}
                      type="button"
                      className={`scan-box${active === index ? ' is-active' : ''}${labelBelow(box, page.height) ? ' label-below' : ''}`}
                      style={boxPercent(box, page.width, page.height)}
                      aria-label={`Hidden detail ${index + 1} of ${page.boxes.length}: ${label}`}
                      onMouseEnter={() => setActive(index)}
                      onMouseLeave={() => setActive((now) => (now === index ? null : now))}
                      onFocus={() => setActive(index)}
                      onBlur={() => setActive((now) => (now === index ? null : now))}
                      onKeyDown={clearOnEscape}
                    >
                      <span className="scan-box-label" aria-hidden="true">
                        {label}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="scan-frame is-missing">
                <p>{page.blocked ? BLOCKED_MESSAGE : UNREADABLE_MESSAGE}</p>
              </div>
            )}
          </figure>
        </div>

        {summary.length > 0 && (
          <ul className="scan-summary" aria-label={`Hidden on ${isPdf ? `page ${current + 1}` : 'this photo'}`}>
            {summary.map(({ label, count }) => (
              <li key={label}>
                {label} <span className="count">{count}</span>
              </li>
            ))}
          </ul>
        )}

        {unreadable.length > 0 && (
          <p className="notice warn" role="alert">
            We couldn’t read {pageList(unreadable)}, so there’s no safe copy of {unreadable.length === 1 ? 'it' : 'them'} and the
            PDF can’t be downloaded yet. Scan {unreadable.length === 1 ? 'that page' : 'those pages'} again, flat and close, in good light.
          </p>
        )}
        {blocked.length > 0 && (
          <p className="notice warn" role="alert">
            We couldn’t black out {pageList(blocked)} safely: a private detail couldn’t be matched to a spot on the picture, so
            there’s no copy of {blocked.length === 1 ? 'it' : 'them'} to download. Scan {blocked.length === 1 ? 'it' : 'them'} again,
            flatter and in better light.
          </p>
        )}
        {missing.length === 0 && toCheck > 0 && (
          <p className="notice warn">
            Some words were hard to read, so they might hide a detail we missed. Check the dashed outlines before you share it.
          </p>
        )}
        {missing.length === 0 && toCheck === 0 && (
          <p className="hint">Check every page before you share it. Handwriting and faint text can be missed.</p>
        )}
        {saveError && (
          <p className="notice warn" role="alert">
            {saveError}
          </p>
        )}

        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onBack}>
            Back
          </button>
          <button type="button" className="btn btn-quiet" onClick={scanAnother}>
            Scan another
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={download}
            disabled={saving || missing.length > 0}
          >
            {saving ? 'Saving…' : isPdf ? 'Download redacted PDF' : 'Download redacted photo'}
          </button>
        </div>
      </section>
    )
  }

  // ---------- Capture ----------

  return (
    <CaptureView
      onBack={onBack}
      onPhoto={(page) => void readPages([page], 'photo', null)}
      onFile={(file) => void openFile(file)}
      fileError={fileError}
    />
  )
}
