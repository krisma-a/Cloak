// The "Scan a document" screen's pure logic: camera errors, file types, box positions, progress and wording.
// No DOM and no Firebase, so it runs under `node --test` (scan.test.ts). StepScan.tsx does the browser parts.

import type { Category } from '../ai/placeholders.ts'
import type { OcrProgress, OcrResult, OcrWord } from '../camera/ocr.ts'

// The OCR types come from src/camera/ocr.ts, so what the screen reads is exactly what readText() returns.
export type { OcrProgress, OcrResult, OcrWord }

// ---------- Shapes shared with the OCR, blackout and PDF code (see scanAi.ts) ----------

/** A rectangle in the page image's own pixels (not the size it is shown at). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One blacked-out area and what kind of detail was under it. Never holds the hidden text. */
export interface ScanBox extends Rect {
  category: Category
}

// ---------- Camera ----------

export type CameraProblem = 'denied' | 'no-camera' | 'in-use' | 'unsupported' | 'other'

/** Turns what getUserMedia() threw into the problem the person can do something about. */
export function cameraProblem(error: unknown): CameraProblem {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use'
    case 'Unsupported':
      return 'unsupported'
    default:
      return 'other'
  }
}

export const CAMERA_MESSAGES: Record<CameraProblem, { title: string; body: string; retry: boolean }> = {
  denied: {
    title: 'Camera is turned off for Cloak',
    body: 'To take a photo, allow the camera in your browser’s address bar, then try again. Or upload a photo or PDF instead.',
    retry: true,
  },
  'no-camera': {
    title: 'No camera found',
    body: 'This device doesn’t seem to have a camera. Upload a photo or PDF instead.',
    retry: true,
  },
  'in-use': {
    title: 'The camera is busy',
    body: 'Another app may be using it. Close that app and try again, or upload a photo or PDF instead.',
    retry: true,
  },
  unsupported: {
    title: 'This browser can’t use the camera here',
    body: 'Upload a photo or PDF instead.',
    retry: false,
  },
  other: {
    title: 'The camera didn’t start',
    body: 'Try again, or upload a photo or PDF instead.',
    retry: true,
  },
}

/** What to ask getUserMedia for. Phones get the back camera when they have one ("ideal", so a front-only phone still works). */
export function videoConstraints(phone: boolean): MediaTrackConstraints {
  return {
    // Text needs pixels: ask for a sharp picture, and take what the camera can do.
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    ...(phone ? { facingMode: { ideal: 'environment' } } : {}),
  }
}

/** A phone or tablet: the browser says so, or the user agent names one and the screen is touch-first. */
export function isPhone(info: { mobile?: boolean; userAgent: string; coarsePointer: boolean }): boolean {
  if (info.mobile !== undefined) return info.mobile || (info.coarsePointer && /iPad|Android/i.test(info.userAgent))
  return /Android|iPhone|iPad|iPod|Mobile/i.test(info.userAgent) || (info.coarsePointer && /Macintosh/i.test(info.userAgent))
}

// ---------- Browser and cameras ----------

export type Platform = 'mac' | 'windows' | 'other'

/** Which computer this is, for showing the matching phone-camera steps first. */
export function platformOf(userAgent: string, platform = ''): Platform {
  const both = `${platform} ${userAgent}`
  if (/Mac/i.test(both) && !/iPhone|iPad|iPod/i.test(both)) return 'mac'
  if (/Win/i.test(both)) return 'windows'
  return 'other'
}

/** Google Chrome itself (not Edge, Brave, Opera or another Chromium browser), where Cloak's private AI can run. */
export function isChromeBrowser(info: { brands?: ReadonlyArray<{ brand: string }>; userAgent: string }): boolean {
  if (info.brands && info.brands.length > 0) return info.brands.some((b) => b.brand === 'Google Chrome')
  return /Chrome\/\d/.test(info.userAgent) && !/Edg\/|OPR\/|Brave|SamsungBrowser|YaBrowser|Vivaldi/.test(info.userAgent)
}

/** A short note above the camera when this setup is less safe than Chrome on a laptop, or null when it's the safe one. */
export interface BrowserAdvice {
  title: string
  body: string
  /** Offer the "Use your phone as the camera" panel from the note. */
  phoneTip: boolean
  /** Offer to copy Cloak's address, to open it in Chrome. */
  copyLink: boolean
}

export function browserAdvice(setup: {
  chrome: boolean
  phone: boolean
  /** Whether Cloak's private AI (Gemini Nano) can run here: null while still checking. */
  privateAi: boolean | null
}): BrowserAdvice | null {
  if (setup.privateAi === true) return null
  if (setup.phone) {
    return {
      title: 'Phones get basic checks',
      body: 'On a phone, Cloak can’t run its private AI, so photos get basic checks, which catch fewer names. For the safest photo, use your phone as the camera for Chrome on a laptop.',
      phoneTip: true,
      copyLink: false,
    }
  }
  if (!setup.chrome) {
    return {
      title: 'For the safest photos, use Chrome',
      body: 'In this browser, Cloak can’t run its private AI, so photos get basic checks, which catch fewer names. Open Cloak in Chrome on a laptop.',
      phoneTip: false,
      copyLink: true,
    }
  }
  if (setup.privateAi === false) {
    return {
      title: 'This laptop gets basic checks',
      body: 'Chrome here can’t run Cloak’s private AI (it needs a recent Chrome and enough memory and disk), so photos get basic checks, which catch fewer names. Check each photo carefully.',
      phoneTip: false,
      copyLink: false,
    }
  }
  return null
}

/** One camera to choose from. The label stays on this device. */
export interface CameraChoice {
  id: string
  label: string
  phone: boolean
}

const PHONE_CAMERA = /iPhone|iPad|Continuity|Desk View|Android|Pixel|Galaxy|Phone/i

/** The cameras to offer, from enumerateDevices(): video inputs only, once each, with a readable label. */
export function cameraChoices(devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>): CameraChoice[] {
  const seen = new Set<string>()
  const choices: CameraChoice[] = []
  for (const device of devices) {
    if (device.kind !== 'videoinput' || !device.deviceId || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    const phone = PHONE_CAMERA.test(device.label)
    const name = device.label.trim() || `Camera ${choices.length + 1}`
    choices.push({ id: device.deviceId, label: phone && !/phone/i.test(name) ? `${name} (phone)` : name, phone })
  }
  return choices
}

const CAMERA_KEY = 'cloak.cameraId'

/** The camera chosen last time in this browser (a convenience; it never leaves the device), or null. */
export function loadCameraId(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(CAMERA_KEY) || null
  } catch {
    return null
  }
}

export function saveCameraId(id: string, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(CAMERA_KEY, id)
  } catch {
    // Not remembered; the choice still applies now.
  }
}

// ---------- Files ----------

export type FileKind = 'image' | 'pdf' | 'unsupported'

/** What an uploaded file is, from its type (or its name when the browser leaves the type empty). */
export function fileKind(type: string, name: string): FileKind {
  if (type === 'application/pdf' || (!type && /\.pdf$/i.test(name))) return 'pdf'
  if (type.startsWith('image/') || (!type && /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(name))) return 'image'
  return 'unsupported'
}

export const UNSUPPORTED_FILE_MESSAGE = 'Cloak can read photos and PDFs. Please choose one of those.'

/** Scales a size down (never up) so its long side is at most `max`. Big photos read no better and take longer. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// ---------- Live preview ----------

/**
 * Where a picture shown with `object-fit: contain` sits inside its frame, in percent of the frame, so boxes drawn in
 * the picture's own pixels line up with it (the camera preview is letterboxed in a 4:3 frame).
 */
export function containRect(
  frame: { width: number; height: number },
  picture: { width: number; height: number },
): { left: string; top: string; width: string; height: string } {
  const fw = Math.max(frame.width, 1)
  const fh = Math.max(frame.height, 1)
  const scale = Math.min(fw / Math.max(picture.width, 1), fh / Math.max(picture.height, 1))
  const w = (picture.width * scale) / fw
  const h = (picture.height * scale) / fh
  const pct = (n: number) => `${Math.round(n * 10000) / 100}%`
  return { left: pct((1 - w) / 2), top: pct((1 - h) / 2), width: pct(w), height: pct(h) }
}

/** What the live preview last saw. Boxes are in the frame's own pixels: one per line of text, never the text itself. */
export type LiveView =
  | { kind: 'starting' }
  | { kind: 'no-text' }
  | { kind: 'text'; lines: Rect[]; width: number; height: number; unclear: boolean }

/** A region of the camera picture in fractions of its size (0 to 1), so it fits the picture at any size. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** Where the frosted pane rests before any text is found: the middle of the picture, so nothing is readable yet. */
export const RESTING_REGION: Region = { x: 0.1, y: 0.08, width: 0.8, height: 0.84 }

/** One region around every line of text, padded by `pad` (a fraction of the picture), or null when there's no text. */
export function textRegion(lines: readonly Rect[], size: { width: number; height: number }, pad = 0.03): Region | null {
  if (lines.length === 0 || size.width <= 0 || size.height <= 0) return null
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const x0 = clamp(Math.min(...lines.map((l) => l.x)) / size.width - pad)
  const y0 = clamp(Math.min(...lines.map((l) => l.y)) / size.height - pad)
  const x1 = clamp(Math.max(...lines.map((l) => l.x + l.width)) / size.width + pad)
  const y1 = clamp(Math.max(...lines.map((l) => l.y + l.height)) / size.height + pad)
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * Moves the pane one animation frame toward `target`, each edge on its own: an edge that must move outward to cover
 * more text moves fast (`grow`, the time constant in ms), one moving inward moves slowly (`shrink`), so new text is
 * covered at once and the pane never flickers open.
 */
export function stepRegion(current: Region, target: Region, dtMs: number, tau = { grow: 90, shrink: 450 }): Region {
  const ease = (from: number, to: number, outward: boolean) => from + (to - from) * (1 - Math.exp(-Math.max(0, dtMs) / (outward ? tau.grow : tau.shrink)))
  const left = ease(current.x, target.x, target.x < current.x)
  const top = ease(current.y, target.y, target.y < current.y)
  const right = ease(current.x + current.width, target.x + target.width, target.x + target.width > current.x + current.width)
  const bottom = ease(current.y + current.height, target.y + target.height, target.y + target.height > current.y + current.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The one line under the camera preview. */
export function liveHint(view: LiveView): string {
  switch (view.kind) {
    case 'starting':
      return 'Getting ready to read the page…'
    case 'no-text':
      return 'Point the camera at the page.'
    case 'text':
      return view.unclear
        ? 'Too hard to read from here. Move closer and hold the page flat.'
        : 'All text is blurred while you aim. After the photo, only the private details stay hidden.'
  }
}

// ---------- Reading ----------

/** The one message for a photo the OCR engine can't read. */
export const UNREADABLE_MESSAGE = 'We couldn’t read this clearly enough to hide the private details. Hold the page flat and close, in good light.'

/** Thrown by readText() when there is no usable text: too dark, too blurry, blank or not a document. */
export class UnreadableScanError extends Error {
  override name = 'UnreadableScanError'
  constructor(message = UNREADABLE_MESSAGE) {
    super(message)
  }
}

/**
 * Average brightness (0..255) and how much it varies, from RGBA pixels. A very dark picture, or one with almost
 * no contrast (a blank wall, a blurred shot), has no text worth reading.
 */
export function brightness(rgba: ArrayLike<number>): { mean: number; spread: number } {
  const pixels = Math.floor(rgba.length / 4)
  if (pixels === 0) return { mean: 0, spread: 0 }
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < pixels * 4; i += 4) {
    const y = 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0)
    sum += y
    sumSq += y * y
  }
  const mean = sum / pixels
  return { mean, spread: Math.sqrt(Math.max(0, sumSq / pixels - mean * mean)) }
}

/** True when a picture is clearly too dark or too flat to hold readable text. */
export function tooDarkOrFlat({ mean, spread }: { mean: number; spread: number }): boolean {
  return mean < 45 || spread < 10
}

/**
 * One progress bar across every page: page `index` (0-based) of `count`, `fraction` of the way through it.
 * PDFs first spend `renderShare` of the bar turning pages into pictures.
 */
export function readingProgress(index: number, count: number, fraction: number, renderShare = 0): number {
  const pages = Math.max(1, count)
  const done = (Math.min(Math.max(index, 0), pages - 1) + Math.min(Math.max(fraction, 0), 1)) / pages
  return Math.min(1, renderShare + (1 - renderShare) * done)
}

/** Share of one page's bar spent starting the OCR engine (the first read downloads it, about 7 MB). */
const ENGINE_SHARE = 0.3

/** OCR progress for one page, 0..1: starting the engine first, then reading the page. */
export function ocrFraction({ stage, fraction }: OcrProgress): number {
  const part = Math.min(Math.max(Number.isFinite(fraction) ? fraction : 0, 0), 1)
  return stage === 'loading' ? part * ENGINE_SHARE : ENGINE_SHARE + part * (1 - ENGINE_SHARE)
}

export function readingLabel(index: number, count: number): string {
  return count > 1 ? `Reading page ${index + 1} of ${count}…` : 'Reading text…'
}

// ---------- Results ----------

export const CATEGORY_LABELS: Record<Category, string> = {
  PERSON: 'Name',
  EMPLOYEE_ID: 'Employee ID',
  EMAIL: 'Email',
  PHONE: 'Phone',
  ADDRESS: 'Address',
  MEDICAL: 'Medical detail',
  SALARY: 'Pay',
  DATE_OF_BIRTH: 'Date of birth',
  ROLE: 'Job title',
  DEPARTMENT: 'Team',
  TENURE: 'Time at company',
  FAMILY_MEDICAL: 'Family medical',
  OTHER_ID: 'ID number',
}

/** Where a box sits on the shown picture, in percent, so it lines up at any size. Clamped to the picture. */
export function boxPercent(box: Rect, width: number, height: number): { left: string; top: string; width: string; height: string } {
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  const x0 = Math.min(Math.max(box.x, 0), w)
  const y0 = Math.min(Math.max(box.y, 0), h)
  const x1 = Math.min(Math.max(box.x + box.width, 0), w)
  const y1 = Math.min(Math.max(box.y + box.height, 0), h)
  const pct = (n: number) => `${Math.round(n * 10000) / 100}%`
  return { left: pct(x0 / w), top: pct(y0 / h), width: pct((x1 - x0) / w), height: pct((y1 - y0) / h) }
}

/** A box near the top of the picture shows its label underneath, so the label isn't cut off. */
export function labelBelow(box: Rect, height: number): boolean {
  return box.y < Math.max(height, 1) * 0.08
}

/** "Name: 2, Medical detail: 1", most first, then in label order. */
export function summarize(boxes: readonly ScanBox[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const box of boxes) {
    const label = CATEGORY_LABELS[box.category]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** The hidden details on one page, one row per category, most first, with the category kept so rows can light up boxes. */
export function hiddenByCategory(boxes: readonly ScanBox[]): Array<{ category: Category; label: string; count: number }> {
  const counts = new Map<Category, number>()
  for (const box of boxes) counts.set(box.category, (counts.get(box.category) ?? 0) + 1)
  return [...counts]
    .map(([category, count]) => ({ category, label: CATEGORY_LABELS[category], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** The result screen's headline and the line under it: the outcome first, then what to do. */
export function resultHeadline(result: {
  hidden: number
  pages: number
  /** No page has a copy (nothing could be read or blacked out safely). */
  noCopy: boolean
  /** Some page was mostly hard to read: details may have been missed. */
  unclear: boolean
}): { title: string; lead: string } {
  const across = result.pages > 1 ? ` across ${result.pages} pages` : ''
  if (result.noCopy) {
    return { title: 'No safe copy yet', lead: 'Here’s what the camera captured. Retake it to get a copy you can share.' }
  }
  if (result.unclear) {
    return {
      title: 'Check this copy before you share it',
      lead: 'Parts were hard to read. Drag across the picture to compare every line with the original.',
    }
  }
  if (result.hidden === 0) {
    return { title: 'Nothing private found', lead: 'Drag across the picture and read the page yourself before you share it.' }
  }
  return {
    title: `${result.hidden} ${result.hidden === 1 ? 'detail' : 'details'} blacked out${across}`,
    lead: 'Drag across the picture to check each box against the original.',
  }
}

export function hiddenCountLabel(count: number): string {
  return count === 0 ? 'Nothing hidden' : `${count} hidden`
}

/** The page numbers (1-based) that couldn't be read. A redacted copy is only safe to download when this is empty. */
export function unreadablePages(pages: ReadonlyArray<{ unreadable: boolean }>): number[] {
  return pages.flatMap((page, index) => (page.unreadable ? [index + 1] : []))
}

/** "page 2" / "pages 2 and 4" / "pages 1, 3 and 5". */
export function pageList(numbers: readonly number[]): string {
  if (numbers.length <= 1) return `page ${numbers[0] ?? ''}`.trim()
  return `pages ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

/** "notes.pdf" -> "notes-redacted.pdf". Uses a plain name when there isn't one to build on. */
export function redactedFileName(original: string | null, extension: 'pdf' | 'png'): string {
  const stem = (original ?? '').replace(/\.[^./\\]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return `${stem || 'scan'}-redacted.${extension}`
}
