// Accessibility settings for the round button. Pure: no DOM, no Firebase. The saved value is
// preferences only (sizes and switches), never anything from a case. Kept in this browser's localStorage.

import { DEFAULT_IDLE_MINUTES, IDLE_MINUTES } from './controls.ts'
import type { IdleMinutes } from './controls.ts'

export const TEXT_SIZES = [100, 115, 130, 150] as const
export type TextSize = (typeof TEXT_SIZES)[number]

export const SPEED_MIN = 0.7
export const SPEED_MAX = 1.3

export interface A11ySettings {
  /** Page size in percent. */
  textSize: TextSize
  highContrast: boolean
  /** Wider letter, word and line spacing, which many people with dyslexia find easier. */
  roomySpacing: boolean
  reduceMotion: boolean
  /** Reading speed for "Read aloud" (1 is normal). */
  speed: number
  /** Minutes without activity before everything is cleared. */
  idleMinutes: IdleMinutes
}

export const DEFAULT_A11Y: A11ySettings = {
  textSize: 100,
  highContrast: false,
  roomySpacing: false,
  reduceMotion: false,
  speed: 1,
  idleMinutes: DEFAULT_IDLE_MINUTES,
}

export const A11Y_KEY = 'cloak.a11y'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Reads what was saved. Anything missing or wrong falls back to the default, so a bad value can never break the page. */
export function parseA11y(raw: string | null): A11ySettings {
  if (!raw) return DEFAULT_A11Y
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return DEFAULT_A11Y
  }
  if (typeof data !== 'object' || data === null) return DEFAULT_A11Y
  const record = data as Record<string, unknown>
  const textSize = TEXT_SIZES.find((size) => size === record.textSize) ?? DEFAULT_A11Y.textSize
  const idleMinutes = IDLE_MINUTES.find((minutes) => minutes === record.idleMinutes) ?? DEFAULT_A11Y.idleMinutes
  const speed =
    typeof record.speed === 'number' && Number.isFinite(record.speed)
      ? Math.round(clamp(record.speed, SPEED_MIN, SPEED_MAX) * 10) / 10
      : DEFAULT_A11Y.speed
  return {
    textSize,
    highContrast: record.highContrast === true,
    roomySpacing: record.roomySpacing === true,
    reduceMotion: record.reduceMotion === true,
    speed,
    idleMinutes,
  }
}

/** One step up or down the list of sizes. Stops at the ends. */
export function stepTextSize(current: TextSize, direction: 1 | -1): TextSize {
  const index = TEXT_SIZES.indexOf(current)
  const next = clamp(index + direction, 0, TEXT_SIZES.length - 1)
  return TEXT_SIZES[next] ?? current
}

/** True when nothing differs from the defaults, so the panel can disable "Reset". */
export function isDefaultA11y(settings: A11ySettings): boolean {
  return (
    settings.textSize === DEFAULT_A11Y.textSize &&
    settings.highContrast === DEFAULT_A11Y.highContrast &&
    settings.roomySpacing === DEFAULT_A11Y.roomySpacing &&
    settings.reduceMotion === DEFAULT_A11Y.reduceMotion &&
    settings.speed === DEFAULT_A11Y.speed &&
    settings.idleMinutes === DEFAULT_A11Y.idleMinutes
  )
}

/** The data attributes the stylesheet reads. Absent means "off". */
export function a11yAttributes(settings: A11ySettings): Record<string, string | undefined> {
  return {
    'data-text-size': settings.textSize === 100 ? undefined : String(settings.textSize),
    'data-contrast': settings.highContrast ? 'high' : undefined,
    'data-spacing': settings.roomySpacing ? 'roomy' : undefined,
    'data-motion': settings.reduceMotion ? 'reduced' : undefined,
  }
}

export function loadA11y(): A11ySettings {
  try {
    return parseA11y(localStorage.getItem(A11Y_KEY))
  } catch {
    return DEFAULT_A11Y
  }
}

export function saveA11y(settings: A11ySettings): void {
  try {
    localStorage.setItem(A11Y_KEY, JSON.stringify(settings))
  } catch {
    // Private windows and blocked storage: the settings still work for this visit.
  }
}
