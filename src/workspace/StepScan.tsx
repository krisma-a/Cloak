import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, RefObject } from 'react'
import type { Category } from '../ai/placeholders.ts'
import { downloadBlob } from '../download.ts'
import { LoadingCard } from './components.tsx'
import { ScanIcon, WhereChip } from './icons.tsx'
import {
  blockedMessage,
  boxPercent,
  browserAdvice,
  cameraChoices,
  CAMERA_MESSAGES,
  AUTO_HOLD_MS,
  AUTO_IDLE,
  autoProgress,
  containRect,
  loadAutoCapture,
  saveAutoCapture,
  stepAutoCapture,
  HEIC_MESSAGE,
  HEIC_TITLE,
  isHeic,
  pdfProblem,
  draftTextFromOcr,
  RESTING_REGION,
  stepRegion,
  textRegion,
  cameraProblem,
  CATEGORY_LABELS,
  fileKind,
  fitWithin,
  hiddenByCategory,
  hiddenCountLabel,
  isChromeBrowser,
  isPhone,
  labelBelow,
  liveHint,
  loadCameraId,
  ocrFraction,
  pageList,
  pickPhoneCamera,
  platformOf,
  readingLabel,
  readingProgress,
  redactedFileName,
  resultHeadline,
  saveCameraId,
  UNREADABLE_MESSAGE,
  UNSUPPORTED_FILE_MESSAGE,
  unreadablePages,
  videoConstraints,
} from './scan.ts'
import type { AutoCaptureState, CameraChoice, CameraProblem, ScanBlockReason, LiveView, Platform, Rect, Region, ScanBox } from './scan.ts'
import { qrMatrix, qrPath } from './qr.ts'
import { blackOut, pagesToPdf, pdfToPages, previewLines, privateAiSupported, readText, warmUpPreview } from './scanAi.ts'

// "Scan a document": take a photo or upload a photo or PDF, read the text ON THIS DEVICE, and show the original
// next to a blacked-out copy. Pictures live in this tab's memory only (canvases and blob: URLs, freed on leaving).
// The camera is on only while the capture view is showing.


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
  /** Which safety check stopped it, when blocked. */
  blockReason: ScanBlockReason | null
  boxes: ScanBox[]
  /** Words read with low confidence, outlined so the person checks them. */
  review: Rect[]
  /** Too much of the page was read badly: details may have been missed, so the copy is risky to use. */
  unclear: boolean
  /** The text read from the page, cleaned of OCR noise, for "Draft a report". In memory only, like pasted notes; never stored. */
  text: string
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
function useCamera(deviceId: string | null, onMissing: () => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>(() =>
    cameraApi() ? { status: 'starting' } : { status: 'problem', problem: 'unsupported' },
  )
  const [attempt, setAttempt] = useState(0)
  const [cameras, setCameras] = useState<CameraChoice[]>([])

  // A callback ref, because the <video> comes and goes (it isn't shown while there's a camera problem).
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element
    show(element, streamRef.current)
  }, [])

  /** The cameras on this device. Their names are only shown once the camera is allowed; they stay on this device. */
  const refreshCameras = useCallback(async (): Promise<CameraChoice[]> => {
    if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return []
    const found = cameraChoices(await navigator.mediaDevices.enumerateDevices())
    setCameras(found)
    return found
  }, [])

  // A phone connected as a camera (Continuity Camera, Phone Link) shows up here without a reload.
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.addEventListener) return
    const update = () => void refreshCameras().catch(() => undefined)
    media.addEventListener('devicechange', update)
    return () => media.removeEventListener('devicechange', update)
  }, [refreshCameras])

  useEffect(() => {
    if (!cameraApi()) return
    let cancelled = false
    const video = { ...videoConstraints(onPhone()), ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }
    navigator.mediaDevices
      .getUserMedia({ video, audio: false })
      .then((media) => {
        if (cancelled) return stopStream(media) // left the screen while the browser was asking
        streamRef.current = media
        media.getVideoTracks()[0]?.addEventListener('ended', () => setState({ status: 'problem', problem: 'other' }))
        show(videoRef.current, media)
        setState({ status: 'live' })
        void refreshCameras().catch(() => undefined)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // The camera chosen last time isn't here any more (a phone that went away): use the default one instead.
        const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
        if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) return onMissing()
        setState({ status: 'problem', problem: cameraProblem(error) })
      })

    return () => {
      cancelled = true
      if (streamRef.current) stopStream(streamRef.current)
      streamRef.current = null
      show(videoRef.current, null)
    }
  }, [attempt, deviceId, onMissing, refreshCameras])

  function retry() {
    setState(cameraApi() ? { status: 'starting' } : { status: 'problem', problem: 'unsupported' })
    setAttempt((n) => n + 1)
  }

  return { videoRef, attachVideo, state, retry, cameras, refreshCameras }
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

/** How long "Find my phone camera" keeps looking for a phone that is still connecting. */
const FIND_SECONDS = 10

/** How long the pane keeps covering where text was after the text drops out of view (a blur, a shake, a hand). */
const FROST_HOLD_MS = 1200

/**
 * Moves the frosted pane smoothly toward the text the live view last found, every animation frame: edges that must
 * grow to cover more text move fast, edges that shrink move slowly, so new text is covered at once and the pane never
 * flickers open. Until the first look finishes it rests over the middle, so nothing is readable yet. With no text in
 * view (a face, a wall) it holds for a moment, then fades out, and comes back straight onto the next text it finds.
 * Positions are written straight to the element, so React doesn't re-render 60 times a second.
 */
function useFrostPane(view: LiveView, pane: RefObject<HTMLDivElement | null>) {
  const latest = useRef<Region | null>(null)
  const seenAt = useRef(0)
  const looked = useRef(false)

  useEffect(() => {
    if (view.kind === 'starting') return
    looked.current = true
    const region = view.kind === 'text' ? textRegion(view.lines, view) : null
    if (!region) return // keep the last text for the hold, then fade
    latest.current = region
    seenAt.current = performance.now()
  }, [view])

  useEffect(() => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let current: Region = { ...RESTING_REGION }
    let shown = true
    let last = performance.now()
    let frame = 0
    const pct = (n: number) => `${(n * 100).toFixed(2)}%`
    const tick = (now: number) => {
      const fresh = latest.current && now - seenAt.current <= FROST_HOLD_MS ? latest.current : null
      const goal = looked.current ? fresh : RESTING_REGION
      const el = pane.current
      if (goal) {
        // Coming back after a fade: appear on the text at once, not slide in from where it faded.
        current = still || !shown ? goal : stepRegion(current, goal, now - last)
        if (el && !shown) {
          el.style.transitionDuration = '80ms' // cover new text quickly
          el.style.opacity = '1'
        }
        shown = true
      } else if (shown) {
        if (el) {
          el.style.transitionDuration = '320ms' // uncover gently
          el.style.opacity = '0'
        }
        shown = false
      }
      last = now
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

/**
 * Takes the photo by itself once a readable page has stayed steady for AUTO_HOLD_MS. Each look of the live view feeds
 * stepAutoCapture(); every animation frame turns that into progress (0 to 1) for the ring, and fires once when it
 * reaches 1. Moving the page, a hard-to-read view or no page resets it; it only runs while the camera is live and
 * `enabled`. Progress is written straight to the element, so React doesn't re-render every frame.
 */
function useAutoCapture(view: LiveView, enabled: boolean, onFire: () => void, ring: RefObject<HTMLDivElement | null>) {
  const state = useRef<AutoCaptureState>(AUTO_IDLE)
  const looked = useRef(0)
  const fire = useRef(onFire)
  const [seconds, setSeconds] = useState<number | null>(null)

  useEffect(() => {
    fire.current = onFire
  })

  useEffect(() => {
    const now = performance.now()
    state.current = enabled ? stepAutoCapture(state.current, view, now) : AUTO_IDLE
    looked.current = now
  }, [view, enabled])

  useEffect(() => {
    if (!enabled) {
      state.current = AUTO_IDLE
      return
    }
    let frame = 0
    let fired = false
    let shown: number | null = null
    const tick = (now: number) => {
      const progress = autoProgress(state.current, now, looked.current)
      ring.current?.style.setProperty('--hold', String(progress))
      const left = progress > 0 ? Math.max(1, Math.ceil(((1 - progress) * AUTO_HOLD_MS) / 1000)) : null
      if (left !== shown) {
        shown = left
        setSeconds(left)
      }
      if (progress >= 1 && !fired) {
        fired = true
        fire.current()
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [enabled, ring])

  return enabled ? seconds : null
}

/** What this browser is, for the safety note and the phone-camera steps. Read from the browser; nothing is stored. */
function browserSetup(): { chrome: boolean; phone: boolean; platform: Platform } {
  const nav = navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }>; platform?: string } }
  return {
    chrome: isChromeBrowser({ brands: nav.userAgentData?.brands, userAgent: nav.userAgent }),
    phone: onPhone(),
    platform: platformOf(nav.userAgent, nav.userAgentData?.platform),
  }
}

/** The address a phone should open: this site, or the live site when running on this laptop (a phone can't open localhost). */
function phoneAddress(): string {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'https://cloak.web.app' : location.origin
}

/**
 * "Use your phone as the camera", as a pop-up with two short ways:
 *  - Open on my phone: a QR code (drawn here by qr.ts, so no outside service sees the address) opens Cloak on the phone,
 *    which then reads the page itself. Phones get basic checks.
 *  - Use it as this laptop's camera (safest): Continuity Camera or Phone Link, then pick the phone in the Camera list.
 * Both end with the one thing to avoid: photographing the page with the phone's camera app.
 */
function PhoneDialog({
  open,
  onClose,
  platform,
  onPhone,
  cameras,
  cameraId,
  onUse,
  onRefresh,
  onFind,
  onCancelFind,
}: {
  open: boolean
  onClose: () => void
  platform: Platform
  onPhone: boolean
  /** The cameras this laptop can see right now (names are known once the camera is allowed). */
  cameras: CameraChoice[]
  /** The camera chosen, or null for the default one. */
  cameraId: string | null
  onUse: (id: string) => void
  /** Looks for cameras again (a phone just connected). */
  onRefresh: () => void
  onFind: (onWait: (secondsLeft: number) => void) => Promise<{ found: boolean; seen: string[] }>
  /** Stops a "Find my phone camera" that is still waiting. */
  onCancelFind: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // Phone cameras first, so a connected phone is the first thing in the list.
  const listed = [...cameras].sort((a, b) => Number(b.phone) - Number(a.phone))
  const hasPhoneCamera = cameras.some((camera) => camera.phone)
  // The ways open on the one that works best right now: the camera list when a phone camera is already visible.
  const [chosenWay, setWay] = useState<'qr' | 'camera' | null>(null)
  const way = onPhone || hasPhoneCamera ? (chosenWay ?? 'camera') : (chosenWay ?? 'qr')
  const [found, setFound] = useState<{ found: boolean; seen: string[] } | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const address = phoneAddress()
  const host = address.replace(/^https?:\/\//, '')
  const matrix = useMemo(() => qrMatrix(address), [address])
  const side = matrix.length + 8 // with the 4-module light margin on each side

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Opening the pop-up looks for cameras again, so a phone that just connected is already in the list. Closing it stops
  // any search that is still waiting.
  useEffect(() => {
    if (open) onRefresh()
    else onCancelFind()
  }, [open, onRefresh, onCancelFind])

  async function find() {
    setFound(null)
    setWaiting(0)
    const result = await onFind((left) => setWaiting(left))
    setWaiting(null)
    setFound(result)
    if (result.found) onClose() // switched to the phone: back to the preview
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const macSteps = (
    <ol className="phone-steps">
      <li>Use the same Apple Account on both, with Wi-Fi and Bluetooth on.</li>
      <li>Hold or mount your iPhone near the Mac, screen locked.</li>
      <li>Choose “iPhone Camera” in the Camera list. “Desk View” films a page lying flat.</li>
    </ol>
  )
  const windowsSteps = (
    <ol className="phone-steps">
      <li>Connect your phone in the Phone Link app.</li>
      <li>In Settings, open Bluetooth &amp; devices, then Mobile devices, and turn on using it as a connected camera.</li>
      <li>Choose your phone in the Camera list.</li>
    </ol>
  )
  const windowsFirst = platform === 'windows'

  return (
    <dialog
      ref={ref}
      className="phone-dialog"
      aria-labelledby="phone-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose() // a click on the dimmed backdrop
      }}
    >
      <div className="phone-dialog-body">
        <div className="phone-dialog-head">
          <h3 id="phone-dialog-title">Use your phone as the camera</h3>
          <button type="button" className="phone-close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {!onPhone && (
          <div className="phone-switch" role="group" aria-label="How to use your phone">
            <button type="button" aria-pressed={way === 'qr'} onClick={() => setWay('qr')}>
              Open on my phone
            </button>
            <button type="button" aria-pressed={way === 'camera'} onClick={() => setWay('camera')}>
              Use it as this laptop’s camera
            </button>
          </div>
        )}

        {way === 'qr' ? (
          <div className="phone-way">
            <div className="phone-qr-row">
              <figure className="phone-qr">
                <svg viewBox={`0 0 ${side} ${side}`} role="img" aria-label={`QR code that opens ${host}`} shapeRendering="crispEdges">
                  <rect width={side} height={side} fill="#fff" />
                  <path d={qrPath(matrix)} fill="#1f2a2e" />
                </svg>
                <span className="phone-qr-corners" aria-hidden="true" />
              </figure>
              <div className="phone-qr-text">
                <ol className="phone-steps">
                  <li>Point your phone’s camera at the code.</li>
                  <li>Tap the link that appears.</li>
                  <li>Choose “Scan a document”.</li>
                </ol>
                <p className="phone-address">
                  <span>{host}</span>
                  <button type="button" className="mini-btn" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </p>
              </div>
            </div>
            <p className="phone-note">
              Your phone reads the page itself, so nothing passes through this laptop. Phones get basic checks, which catch
              fewer names than Chrome on a laptop.
            </p>
          </div>
        ) : (
          <div className="phone-way">
            <p className="phone-lead">
              <strong>The safest way.</strong> The picture goes straight into Chrome on this laptop, where Cloak’s private AI
              checks it. Nothing is saved on your phone.
            </p>
            {listed.length > 0 && (
              <ul className="phone-cameras" aria-label="Cameras this laptop can see">
                {listed.map((camera) => (
                  <li key={camera.id} className={camera.phone ? 'is-phone' : undefined}>
                    <span className="phone-camera-name">
                      {camera.label}
                      {camera.phone && <span className="phone-camera-tag">Phone</span>}
                    </span>
                    {cameraId === camera.id ? (
                      <span className="phone-camera-using">In use</span>
                    ) : (
                      <button
                        type="button"
                        className={camera.phone ? 'mini-btn is-main' : 'mini-btn'}
                        onClick={() => {
                          onUse(camera.id)
                          onClose()
                        }}
                      >
                        Use this camera
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!hasPhoneCamera && !onPhone && (
              <p className="phone-none">
                {listed.length > 0 ? 'No phone camera yet. ' : 'No cameras found yet. '}Connect your phone with the steps below, and it appears in
                this list by itself.
              </p>
            )}
            <details className="phone-steps-box" open={!hasPhoneCamera}>
              <summary>{hasPhoneCamera ? 'Not seeing your phone? Setup steps' : 'Setup steps'}</summary>
              <h4 className="phone-os-title">{windowsFirst ? 'Windows and Android' : 'Mac and iPhone'}</h4>
              {windowsFirst ? windowsSteps : macSteps}
              <details className="phone-other">
                <summary>{windowsFirst ? 'Using a Mac and iPhone?' : 'Using Windows and Android?'}</summary>
                {windowsFirst ? macSteps : windowsSteps}
              </details>
            </details>
            {!onPhone && (
              <div className="phone-find">
                <button type="button" className="mini-btn" onClick={find} disabled={waiting !== null}>
                  {waiting !== null ? 'Looking for your phone…' : 'Find my phone camera'}
                </button>
                <span role="status" aria-live="polite">
                  {waiting !== null
                    ? 'Unlock your phone and keep it near this laptop.'
                    : found && !found.found
                      ? `No phone camera found. Cloak can see: ${found.seen.length ? found.seen.join(', ') : 'no cameras'}. Chrome lists a phone only once your system offers it as a camera, so check the steps above, then try again.`
                      : ''}
                </span>
              </div>
            )}
          </div>
        )}

        <p className="phone-avoid">
          Don’t photograph the page with your phone’s camera app: it saves it to your camera roll, which may back up to the
          cloud.
        </p>
      </div>
    </dialog>
  )
}

/** The camera preview plus "Upload a photo or PDF". The camera runs only while this is on screen. */
function CaptureView({ onBack, onPhoto, onFile, fileError }: CaptureViewProps) {
  const [cameraId, setCameraId] = useState<string | null>(() => loadCameraId())
  const forgetCamera = useCallback(() => setCameraId(null), [])
  const { videoRef, attachVideo, state, retry, cameras, refreshCameras } = useCamera(cameraId, forgetCamera)
  const [privateAi, setPrivateAi] = useState<boolean | null>(null)
  const [phoneHelp, setPhoneHelp] = useState(false)
  const [copied, setCopied] = useState(false)
  const setup = browserSetup()
  const advice = browserAdvice({ chrome: setup.chrome, phone: setup.phone, privateAi })

  useEffect(() => {
    let current = true
    privateAiSupported().then(
      (ok) => current && setPrivateAi(ok),
      () => current && setPrivateAi(false),
    )
    return () => {
      current = false
    }
  }, [])

  function chooseCamera(id: string) {
    saveCameraId(id)
    setCameraId(id)
  }

  const refreshCameraList = useCallback(() => void refreshCameras().catch(() => undefined), [refreshCameras])

  // Bumped to stop a "Find my phone camera" that is still waiting (the pop-up closed, or it was started again).
  const findRun = useRef(0)
  const cancelFind = useCallback(() => {
    findRun.current++
  }, [])

  /**
   * "Find my phone camera": look now, then every second for up to FIND_SECONDS, because a connected phone often takes a
   * few seconds to appear. Switches to the first phone-named camera or camera that wasn't there when this started.
   * Reports what it can see, so a miss isn't a mystery.
   */
  async function findPhoneCamera(onWait: (secondsLeft: number) => void): Promise<{ found: boolean; seen: string[] }> {
    const run = ++findRun.current
    const start = await refreshCameras().catch(() => cameras)
    let latest = start
    for (let waited = 0; waited <= FIND_SECONDS; waited++) {
      if (findRun.current !== run) return { found: false, seen: latest.map((camera) => camera.label) }
      if (waited > 0) latest = await refreshCameras().catch(() => latest)
      const phone = pickPhoneCamera(start, latest)
      if (phone) {
        if (phone.id !== cameraId) chooseCamera(phone.id)
        return { found: true, seen: latest.map((camera) => camera.label) }
      }
      if (waited < FIND_SECONDS) {
        onWait(FIND_SECONDS - waited)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    return { found: false, seen: latest.map((camera) => camera.label) }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(location.origin)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const [videoReady, setVideoReady] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const problem = state.status === 'problem' ? CAMERA_MESSAGES[state.problem] : null
  const canShoot = state.status === 'live' && videoReady
  const live = useLiveView(videoRef, canShoot)
  const [autoOn, setAutoOn] = useState(() => loadAutoCapture())
  const ringRef = useRef<HTMLDivElement>(null)
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

  // Auto-capture waits while the phone pop-up is open, so a photo isn't taken behind it.
  const holdSeconds = useAutoCapture(live, autoOn && canShoot && !phoneHelp, takePhoto, ringRef)
  function chooseAuto(on: boolean) {
    saveAutoCapture(on)
    setAutoOn(on)
  }

  return (
    <section className="card scan" aria-labelledby="scan-title">
      <WhereChip where="laptop">On this device</WhereChip>
      <h2 id="scan-title" tabIndex={-1} className="scan-title">
        Scan a document
      </h2>
      <p className="muted">Hold the page flat in good light. Cloak reads it on this device and blacks out the private details.</p>

      {advice && (
        <div className="notice warn scan-advice" role="note">
          <p>
            <strong>{advice.title}.</strong> {advice.body}
          </p>
          {(advice.copyLink || advice.phoneTip) && (
            <div className="scan-advice-actions">
              {advice.copyLink && (
                <button type="button" className="mini-btn" onClick={copyAddress}>
                  {copied ? 'Address copied' : 'Copy Cloak’s address'}
                </button>
              )}
              {advice.phoneTip && (
                <button type="button" className="mini-btn" onClick={() => setPhoneHelp(true)} aria-haspopup="dialog">
                  Show me how
                </button>
              )}
            </div>
          )}
        </div>
      )}

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
          {holdSeconds !== null && (
            <div className="scan-hold" ref={ringRef} role="status" aria-live="polite">
              <span className="scan-hold-ring" aria-hidden="true" />
              Hold still… {holdSeconds}
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

      {!problem && (
        <div className="scan-under">
          {canShoot && (
            <p className={`scan-live-hint${live.kind === 'text' && live.unclear ? ' is-warn' : ''}`} role="status" aria-live="polite">
              {liveHint(live)}
            </p>
          )}
          <div className="scan-camera-tools">
            {cameras.length > 1 && (
              <label className="scan-camera-pick">
                <span>Camera</span>
                <select value={cameraId && cameras.some((c) => c.id === cameraId) ? cameraId : ''} onChange={(event) => chooseCamera(event.target.value)}>
                  {!cameras.some((c) => c.id === cameraId) && <option value="">Default camera</option>}
                  {cameras.map((camera) => (
                    <option key={camera.id} value={camera.id}>
                      {camera.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="scan-auto">
              <input type="checkbox" role="switch" checked={autoOn} onChange={(event) => chooseAuto(event.target.checked)} />
              <span className="scan-auto-track" aria-hidden="true" />
              Auto-capture
            </label>
            {!setup.phone && (
              <button type="button" className="scan-phone-toggle" aria-haspopup="dialog" onClick={() => setPhoneHelp(true)}>
                Use your phone as the camera
              </button>
            )}
          </div>
        </div>
      )}

      <PhoneDialog
        open={phoneHelp}
        onClose={() => setPhoneHelp(false)}
        platform={setup.platform}
        onPhone={setup.phone}
        cameras={cameras}
        cameraId={cameraId}
        onUse={chooseCamera}
        onRefresh={refreshCameraList}
        onFind={findPhoneCamera}
        onCancelFind={cancelFind}
      />

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

/**
 * The pop-up before a scanned page goes on to drafting, the only step that sends anything to the cloud. It says what
 * stays on this laptop (the photo, the real details) and what is sent (the text with placeholders, after a check),
 * the three steps that come next, and warns harder when the page was hard to read or gets basic checks.
 */
function DraftReviewDialog({
  open,
  unclear,
  basicChecks,
  onClose,
  onContinue,
}: {
  open: boolean
  unclear: boolean
  basicChecks: boolean
  onClose: () => void
  onContinue: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="draft-dialog"
      aria-labelledby="draft-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="draft-dialog-body">
        <h3 id="draft-dialog-title">Check before anything goes to the cloud</h3>

        <div className="draft-split">
          <div className="draft-side is-stays">
            <h4>Stays on this laptop</h4>
            <ul>
              <li>The photo</li>
              <li>The real names, numbers and health details</li>
            </ul>
          </div>
          <div className="draft-side is-sent">
            <h4>Sent to write the draft</h4>
            <p>The text, with placeholders instead of private details:</p>
            <p className="draft-sample">
              Met with <span className="draft-chip">[EMPLOYEE_1]</span> about a desk move.
            </p>
          </div>
        </div>

        <ol className="draft-steps">
          <li>Cloak hides the private details in the text it read, on this laptop.</li>
          <li>You check every hidden detail on the next screen.</li>
          <li>Only then do you pick a report type and send it.</li>
        </ol>

        {(unclear || basicChecks) && (
          <p className="draft-warn" role="note">
            <strong>Read the next screen closely.</strong>{' '}
            {unclear ? 'Parts of this page were hard to read, so some private details may not be caught. ' : ''}
            {basicChecks ? 'This laptop uses basic checks, which catch fewer names. ' : ''}
            Hide anything Cloak missed before you send.
          </p>
        )}

        <div className="draft-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Back to the photo
          </button>
          <button type="button" className="btn btn-primary" onClick={onContinue} autoFocus>
            Check the text
          </button>
        </div>
      </div>
    </dialog>
  )
}

interface StepScanProps {
  onBack: () => void
  /** "Draft a report": hand the page text to the note pipeline (hide details on this laptop, check them, then send). */
  onDraft?: (text: string) => void
  /** The notes will get basic checks (chosen, or no private AI here): the review pop-up warns about it. */
  basicChecks?: boolean
}

export function StepScan({ onBack, onDraft, basicChecks = false }: StepScanProps) {
  const [draftAsk, setDraftAsk] = useState(false)
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
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, blockReason: null, boxes: [], review: [], unclear: false, text: '' })
          continue
        }
        if (!still()) return
        if (ocr.words.length === 0) {
          // The reader ran but found no text: a blank, blurry or too-dark shot.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: false, blockReason: null, boxes: [], review: [], unclear: false, text: '' })
          continue
        }
        setPhase({ kind: 'reading', progress: readingProgress(index, pages.length, 1, share), label: 'Finding private details…' })
        const result = await blackOut(page, ocr)
        if (!still()) return
        if (result.status === 'blocked') {
          // Fail closed: no copy at all rather than one that might show a detail.
          scanned.push({ width: page.width, height: page.height, originalUrl: original, redacted: null, blocked: true, blockReason: result.reason, boxes: [], review: [], unclear: false, text: draftTextFromOcr(ocr) })
          continue
        }
        const blob = await toBlob(result.redacted)
        scanned.push({
          width: page.width,
          height: page.height,
          originalUrl: original,
          redacted: { canvas: result.redacted, blob, url: makeUrl(blob) },
          blocked: false,
          blockReason: null,
          boxes: result.boxes,
          review: result.review,
          unclear: result.unclear,
          text: draftTextFromOcr(ocr),
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
        // iPhone HEIC photos are the common case Chrome can't open; anything else is damaged or not a picture.
        if (isHeic(file.type, file.name)) showProblem(HEIC_TITLE, HEIC_MESSAGE)
        else showProblem('We couldn’t read this', UNREADABLE_MESSAGE)
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
    } catch (error) {
      if (run.current !== id) return
      const problem = pdfProblem(error)
      showProblem(problem.title, problem.message)
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
      const reason = pages.find((p) => p.blockReason)?.blockReason ?? 'unplaced'
      status = { text: `${isPdf ? `${pageList(blocked).replace(/^p/, 'P')}: ` : ''}${blockedMessage(reason)}` }
    } else if (unclear.length > 0) {
      status = {
        strong: 'Cloak may have missed private details.',
        text: ` Much of ${isPdf ? pageList(unclear) : 'this photo'} was hard to read, so names, numbers or health details may still show. It’s risky to share this copy or write a draft from it.`,
      }
    } else if (toCheck > 0) {
      status = { text: 'Some words were hard to read, so they might hide a detail Cloak missed. Check the picture closely before you share it.' }
    }

    return (
      <section className="card scan scan-result" aria-labelledby="scan-title">
        <WhereChip where="laptop">On this device</WhereChip>
        <h2 id="scan-title" tabIndex={-1} className="scan-title scan-verdict">
          {headline.title}
        </h2>
        <p className="scan-lead">{headline.lead}</p>


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
            {!page.redacted && isPdf && (
              <figcaption className="scan-wipe-missing">{page.blockReason ? blockedMessage(page.blockReason) : UNREADABLE_MESSAGE}</figcaption>
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
          {onDraft && (
            <button type="button" className="btn btn-outline" onClick={() => setDraftAsk(true)} disabled={!pages.some((p) => p.text.trim())} aria-haspopup="dialog">
              Draft a report
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={download} disabled={saving || missing.length > 0}>
            {saving ? 'Saving…' : isPdf ? 'Download redacted PDF' : 'Download redacted photo'}
          </button>
        </div>

        {onDraft && (
          <DraftReviewDialog
            open={draftAsk}
            unclear={unclear.length > 0}
            basicChecks={basicChecks}
            onClose={() => setDraftAsk(false)}
            onContinue={() => {
              setDraftAsk(false)
              onDraft(
                pages
                  .map((p) => p.text.trim())
                  .filter(Boolean)
                  .join('\n\n'),
              )
            }}
          />
        )}
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
