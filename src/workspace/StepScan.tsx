import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, RefObject } from 'react'
import type { Category } from '../ai/placeholders.ts'
import { downloadBlob } from '../download.ts'
import { LoadingCard } from './components.tsx'
import { ScanIcon, WhereChip } from './icons.tsx'
import {
  boxPercent,
  CAMERA_MESSAGES,
  containRect,
  RESTING_REGION,
  stepRegion,
  textRegion,
  cameraProblem,
  CATEGORY_LABELS,
  fileKind,
  fitWithin,
  hiddenByCategory,
  hiddenCountLabel,
  isPhone,
  labelBelow,
  liveHint,
  ocrFraction,
  pageList,
  readingLabel,
  readingProgress,
  redactedFileName,
  resultHeadline,
  UNREADABLE_MESSAGE,
  UNSUPPORTED_FILE_MESSAGE,
  unreadablePages,
  videoConstraints,
} from './scan.ts'
import type { CameraProblem, LiveView, Rect, Region, ScanBox } from './scan.ts'
import { blackOut, pagesToPdf, PDF_DEMO, pdfToPages, previewLines, readText, warmUpPreview } from './scanAi.ts'

// "Scan a document": take a photo or upload a photo or PDF, read the text ON THIS DEVICE, and show the original
// next to a blacked-out copy. Pictures live in this tab's memory only (canvases and blob: URLs, freed on leaving).
// The camera is on only while the capture view is showing.

const BLOCKED_MESSAGE =
  'A private detail couldn’t be matched to a spot on the picture, so no copy was made. Try again, flatter and in better light.'

/** Long side of a picture we read. Bigger photos take longer and read no better. */
const MAX_SIDE = 2400
/** Long side of a live preview frame: smaller than a photo, so each look is quick. */
const LIVE_SIDE = 960
/** A short rest between live looks, so the page stays responsive on a slow laptop. */
const LIVE_PAUSE_MS = 100

/** Where the compare handle rests on the result: mostly the blacked-out copy, with the original just in view. */
const RESTING_SPLIT = 72

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
  /** Too much of the page was read badly: details may have been missed, so the copy is risky to use. */
  unclear: boolean
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
 * While the camera is live: reads one frame at a time and blurs every line of text on the preview (on this device,
 * text reader only, no redaction). One look at a time; paused while the tab is hidden; stops when the preview goes
 * away. A preview only: the photo gets its own full check, and then only the private details stay hidden.
 */
function useLiveView(videoRef: RefObject<HTMLVideoElement | null>, active: boolean): LiveView {
  const [view, setView] = useState<LiveView>({ kind: 'starting' })

  // Load the text reader (and the name model, for the photo) as soon as the camera view opens, before the video is ready.
  useEffect(() => {
    void warmUpPreview().catch(() => undefined)
  }, [])

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
          const seen = await previewLines(frame, ocr)
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

/** How long the pane keeps covering where text was after the text drops out of view (a blur, a shake, a hand). */
const FROST_HOLD_MS = 1200

/**
 * Moves the frosted pane smoothly toward the text the live view last found, every animation frame: edges that must
 * grow to cover more text move fast, edges that shrink move slowly, so new text is covered at once and the pane never
 * flickers open. With no text for a moment it holds still, then returns to rest over the middle. Positions are
 * written straight to the element, so React doesn't re-render 60 times a second.
 */
function useFrostPane(view: LiveView, pane: RefObject<HTMLDivElement | null>) {
  const target = useRef<Region>(RESTING_REGION)
  const seenAt = useRef(0)

  useEffect(() => {
    if (view.kind !== 'text') return
    const region = textRegion(view.lines, view)
    if (!region) return
    target.current = region
    seenAt.current = performance.now()
  }, [view])

  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let current: Region = { ...RESTING_REGION }
    let last = performance.now()
    let frame = 0
    const pct = (n: number) => `${(n * 100).toFixed(2)}%`
    const tick = (now: number) => {
      const goal = seenAt.current > 0 && now - seenAt.current > FROST_HOLD_MS ? RESTING_REGION : target.current
      current = still ? goal : stepRegion(current, goal, now - last)
      last = now
      const el = pane.current
      if (el) {
        el.style.left = pct(current.x)
        el.style.top = pct(current.y)
        el.style.width = pct(current.width)
        el.style.height = pct(current.height)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [pane])
}

/** The camera preview plus "Upload a photo or PDF". The camera runs only while this is on screen. */
function CaptureView({ onBack, onPhoto, onFile, fileError }: CaptureViewProps) {
  const { videoRef, attachVideo, state, retry } = useCamera()
  const [videoReady, setVideoReady] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const problem = state.status === 'problem' ? CAMERA_MESSAGES[state.problem] : null
  const canShoot = state.status === 'live' && videoReady
  const live = useLiveView(videoRef, canShoot)
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  useFrostPane(live, paneRef)
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
            onLoadedData={(event) => {
              setVideoReady(true)
              setVideoSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })
            }}
            onResize={(event) => setVideoSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
            onEmptied={() => setVideoReady(false)}
          />
          {canShoot && frameBox && videoSize && (
            // One frosted pane over the text, on the picture itself (not the letterbox bars). It is there from the
            // first frame, resting over the middle, and glides onto the text once it is found.
            <div className="scan-live" style={containRect(frameBox, videoSize)} aria-hidden="true">
              <div ref={paneRef} className="scan-frost" />
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
        <p className={`scan-live-hint${live.kind === 'text' && live.unclear ? ' is-warn' : ''}`} role="status" aria-live="polite">
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
  // The category a row of "What's hidden" is pointing at: its boxes light up on the picture.
  const [litCategory, setLitCategory] = useState<Category | null>(null)
  // Where the compare handle is: 0 = all original, 100 = all blacked-out copy.
  const [split, setSplit] = useState(RESTING_SPLIT)
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

  // When the result opens, the blacked-out copy wipes in over the original once, then rests with the original in view,
  // so the handle explains itself. Skipped when the person prefers less motion.
  useEffect(() => {
    if (phase.kind !== 'result') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return // already at rest (set with the result)
    let frame = 0
    const started = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 900)
      const eased = 1 - Math.pow(1 - t, 3)
      setSplit(Math.round(RESTING_SPLIT * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase.kind])

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
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, boxes: [], review: [], unclear: false })
          continue
        }
        if (!still()) return
        if (ocr.words.length === 0) {
          // The reader ran but found no text: a blank, blurry or too-dark shot.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, boxes: [], review: [], unclear: false })
          continue
        }
        setPhase({ kind: 'reading', progress: readingProgress(index, pages.length, 1, share), label: 'Finding private details…' })
        const result = await blackOut(page, ocr)
        if (!still()) return
        if (result.status === 'blocked') {
          // Fail closed: no copy at all rather than one that might show a detail.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: true, boxes: [], review: [], unclear: false })
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
          unclear: result.unclear,
        })
      }
    } catch {
      if (still()) showProblem('Something went wrong', 'Something went wrong on this device. Nothing was sent anywhere. Please try again.')
      return
    }
    if (!still()) return

    // Always show what was captured, next to whatever copy could be made: a page with no safe copy says why, and the
    // download stays off until every page has one.
    setCurrent(0)
    setActive(null)
    setLitCategory(null)
    setSplit(RESTING_SPLIT)
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
    const unclear = unreadablePages(pages.map((p) => ({ unreadable: p.redacted !== null && p.unclear })))
    const totalHidden = pages.reduce((sum, p) => sum + p.boxes.length, 0)
    const isPdf = phase.source === 'pdf'

    const clearOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Escape') event.currentTarget.blur()
    }

    const headline = resultHeadline({
      hidden: totalHidden,
      pages: pages.length,
      noCopy: missing.length === pages.length,
      unclear: unclear.length > 0,
    })
    const rows = hiddenByCategory(page.boxes)
    const where = isPdf ? `page ${current + 1}` : 'this photo'

    // One status message for the whole result, the most serious first.
    let status: { strong?: string; text: string } | null = null
    if (unreadable.length > 0) {
      status = isPdf
        ? {
            text: `We couldn’t read ${pageList(unreadable)}, so the PDF can’t be downloaded yet. Scan ${unreadable.length === 1 ? 'that page' : 'those pages'} again, flat and close, in good light.`,
          }
        : { text: 'We couldn’t read any text in this photo, so there’s no copy to download. Retake it flat and close, in good light.' }
    } else if (blocked.length > 0) {
      status = {
        text: `A private detail on ${isPdf ? pageList(blocked) : 'this photo'} couldn’t be matched to a spot on the picture, so there’s no copy to download. Retake it flatter and in better light.`,
      }
    } else if (unclear.length > 0) {
      status = {
        strong: 'Cloak may have missed private details.',
        text: ` Much of ${isPdf ? pageList(unclear) : 'this photo'} was hard to read, so names, numbers or health details may still show. It’s risky to share this copy or write a draft from it.`,
      }
    } else if (toCheck > 0) {
      status = { text: 'Some words were hard to read. Check the dashed outlines: they might hide a detail Cloak missed.' }
    }

    return (
      <section className="card scan scan-result" aria-labelledby="scan-title">
        <WhereChip where="laptop">On this device</WhereChip>
        <h2 id="scan-title" tabIndex={-1} className="scan-title scan-verdict">
          {headline.title}
        </h2>
        <p className="scan-lead">{headline.lead}</p>

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
                    setLitCategory(null)
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

        <div className="scan-check">
          <figure className="scan-wipe">
            {/* One picture: the blacked-out copy on the left of the handle, the original on the right, so every box
                can be checked against the exact words it covers. */}
            <div className="scan-frame" style={{ '--split': split / 100 } as CSSProperties}>
              <img
                src={page.originalUrl}
                width={page.width}
                height={page.height}
                alt={`Original${isPdf ? ` page ${current + 1}` : ' photo'}`}
              />
              {page.redacted && (
                <>
                  <img
                    className="scan-wipe-copy"
                    src={page.redacted.url}
                    width={page.width}
                    height={page.height}
                    alt={`Blacked-out copy${isPdf ? ` of page ${current + 1}` : ''}, ${hiddenCountLabel(page.boxes.length).toLowerCase()}`}
                  />
                  <span className="scan-wipe-line" aria-hidden="true" />
                  <span className="scan-wipe-tag is-copy" aria-hidden="true">
                    Blacked out
                  </span>
                  <span className="scan-wipe-tag is-original" aria-hidden="true">
                    Original
                  </span>
                  {page.review.map((spot) => (
                    <span key={`review-${spot.x}-${spot.y}`} className="scan-review" style={boxPercent(spot, page.width, page.height)} aria-hidden="true" />
                  ))}
                  {page.boxes.map((box, index) => {
                    const label = CATEGORY_LABELS[box.category]
                    return (
                      <button
                        key={`${box.x}-${box.y}-${index}`}
                        type="button"
                        className={`scan-box${active === index ? ' is-active' : ''}${litCategory === box.category ? ' is-lit' : ''}${labelBelow(box, page.height) ? ' label-below' : ''}`}
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
                  <input
                    className="scan-wipe-handle"
                    type="range"
                    min={0}
                    max={100}
                    value={split}
                    onChange={(event) => setSplit(Number(event.target.value))}
                    aria-label="Compare the blacked-out copy with the original"
                    aria-valuetext={`${split}% blacked-out copy`}
                  />
                </>
              )}
            </div>
            {!page.redacted && (
              <figcaption className="scan-wipe-missing">{page.blocked ? BLOCKED_MESSAGE : UNREADABLE_MESSAGE}</figcaption>
            )}
          </figure>

          <aside className="scan-ledger" aria-labelledby="scan-ledger-title">
            <h3 id="scan-ledger-title">What’s hidden{isPdf ? ` on page ${current + 1}` : ''}</h3>
            {rows.length > 0 ? (
              <ul className="scan-ledger-rows">
                {rows.map((row) => (
                  <li key={row.category}>
                    <button
                      type="button"
                      className={`scan-ledger-row${litCategory === row.category ? ' is-lit' : ''}`}
                      onMouseEnter={() => setLitCategory(row.category)}
                      onMouseLeave={() => setLitCategory((now) => (now === row.category ? null : now))}
                      onFocus={() => setLitCategory(row.category)}
                      onBlur={() => setLitCategory((now) => (now === row.category ? null : now))}
                      aria-label={`${row.label}: ${row.count} hidden. Shows where on the picture.`}
                    >
                      <span className="scan-ledger-swatch" aria-hidden="true" />
                      <span className="scan-ledger-label">{row.label}</span>
                      <span className="scan-ledger-count">{row.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="scan-ledger-empty">
                {!page.redacted
                  ? `No copy of ${where}, so nothing is hidden yet.`
                  : page.unclear
                    ? 'Nothing found in the parts Cloak could read.'
                    : `Nothing private found on ${where}.`}
              </p>
            )}

            {status ? (
              <p className="scan-status" role="alert">
                {status.strong && <strong>{status.strong}</strong>}
                {status.text}
              </p>
            ) : (
              <p className="scan-ledger-note">Handwriting and faint text can be missed. Read every line before you share it.</p>
            )}
            {saveError && (
              <p className="scan-status" role="alert">
                {saveError}
              </p>
            )}

          </aside>
        </div>

        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onBack}>
            Back
          </button>
          <button type="button" className="btn btn-quiet" onClick={scanAnother}>
            Scan another
          </button>
          <button type="button" className="btn btn-primary" onClick={download} disabled={saving || missing.length > 0}>
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
