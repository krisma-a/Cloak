// "Cloak runs best on…": the one-time notice for slower or unsupported devices. Pure, so tests run in Node.
//
// The bar is Chrome's own requirement for its built-in AI (Gemini Nano), which Cloak's best private check uses
// (developer.chrome.com/docs/ai/get-started): Windows 10/11, macOS 13+, Linux, or a Chromebook Plus; a GPU with more
// than 4 GB of memory, or 16 GB of RAM and 4+ CPU cores; at least 22 GB free on the disk Chrome uses; an unmetered
// connection for the one-time download. Phones and tablets aren't supported.
//
// A web page can't see free disk space or exact memory (Chrome reports at most 8 GB), so those rows say "can't tell"
// instead of guessing. Nothing here is stored or sent; only "seen" is remembered, in this browser.

import { isChromeBrowser, isPhone, platformOf } from './scan.ts'
import type { Platform } from './scan.ts'

export type SpecMark = 'ok' | 'short' | 'unknown'

export interface SpecRow {
  label: string
  needs: string
  /** What this device has, in words ("Chrome", "8 cores"), or why it can't tell. */
  here: string
  mark: SpecMark
}

export interface DeviceInfo {
  brands?: ReadonlyArray<{ brand: string }>
  userAgent: string
  platform?: string
  mobile?: boolean
  coarsePointer: boolean
  /** navigator.hardwareConcurrency, when known. */
  cores?: number
  /** navigator.deviceMemory in GB (Chrome only, rounded and capped at 8), when known. */
  memoryGb?: number
  /** Whether the private AI can run here: null while still checking. */
  privateAi: boolean | null
}

// On an iPhone or iPad every browser runs on Safari's engine and its user agent ends in "Safari/", so the app's own
// marker comes first: CriOS (Chrome), FxiOS (Firefox), EdgiOS (Edge), OPiOS / OPT (Opera).
const BROWSERS: Array<[RegExp, string]> = [
  [/CriOS\//, 'Chrome'],
  [/FxiOS\//, 'Firefox'],
  [/EdgiOS\//, 'Edge'],
  [/OPiOS\/|OPT\//, 'Opera'],
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Brave/, 'Brave'],
  [/Firefox\//, 'Firefox'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

/** A readable browser name, for the "This device" column. */
export function browserName(info: Pick<DeviceInfo, 'brands' | 'userAgent'>): string {
  if (isChromeBrowser(info)) return 'Chrome'
  const brand = info.brands?.map((b) => b.brand).find((b) => !/Chromium|Not.?A.?Brand/i.test(b))
  if (brand) return brand.replace(/^Microsoft /, '')
  if (info.brands?.some((b) => /Chromium/i.test(b.brand))) return 'Chromium' // a Chromium browser that isn't Google Chrome
  return BROWSERS.find(([pattern]) => pattern.test(info.userAgent))?.[1] ?? 'Another browser'
}

const SYSTEM_NAMES: Record<Platform, string> = { mac: 'macOS', windows: 'Windows', other: '' }

/** The spec sheet: what Cloak needs next to what this device has. */
export function specRows(info: DeviceInfo): SpecRow[] {
  const phone = isPhone(info)
  const chrome = isChromeBrowser(info)
  const platform = platformOf(info.userAgent, info.platform)
  const linuxOrChromeOs = /Linux|CrOS/i.test(`${info.platform ?? ''} ${info.userAgent}`) && !/Android/i.test(info.userAgent)
  const systemHere = phone ? 'A phone or tablet' : SYSTEM_NAMES[platform] || (linuxOrChromeOs ? 'Linux or ChromeOS' : 'Unknown')

  const rows: SpecRow[] = [
    { label: 'Browser', needs: 'Chrome', here: browserName(info), mark: chrome ? 'ok' : 'short' },
    {
      label: 'System',
      needs: 'Windows 10 or 11, macOS 13+, Linux or a Chromebook Plus',
      here: systemHere,
      // The version (Windows 10 vs 11, macOS 12 vs 13) isn't visible to a web page, so a laptop system counts as fine.
      mark: phone ? 'short' : platform !== 'other' || linuxOrChromeOs ? 'ok' : 'unknown',
    },
    {
      label: 'Private AI',
      needs: 'Gemini Nano in Chrome',
      here: info.privateAi === null ? 'Still checking' : info.privateAi ? 'Ready to use' : 'Not available here',
      mark: info.privateAi === null ? 'unknown' : info.privateAi ? 'ok' : 'short',
    },
    {
      label: 'Processor',
      needs: '4 cores or more',
      here: info.cores ? `${info.cores} cores` : 'Can’t tell',
      mark: info.cores ? (info.cores >= 4 ? 'ok' : 'short') : 'unknown',
    },
    {
      label: 'Memory',
      needs: '16 GB, or a graphics card with more than 4 GB',
      here:
        info.memoryGb === undefined ? 'Can’t tell from a web page' : info.memoryGb >= 8 ? '8 GB or more' : `About ${info.memoryGb} GB`,
      // Chrome reports at most 8 GB, so 8 can't confirm 16; under 8 is clearly short.
      mark: info.memoryGb !== undefined && info.memoryGb < 8 ? 'short' : 'unknown',
    },
    { label: 'Free space', needs: '22 GB on the disk Chrome uses', here: 'Can’t tell from a web page', mark: 'unknown' },
  ]
  return rows
}

/**
 * Whether to show the notice: something is clearly short. With the private AI ready, only a slow processor or little
 * memory counts (Full Cloak works, but slowly, so basic checks are worth offering).
 */
export function shouldShowSpecs(info: DeviceInfo): boolean {
  if (info.privateAi === true) return specRows(info).some((row) => (row.label === 'Processor' || row.label === 'Memory') && row.mark === 'short')
  if (info.privateAi === null && isChromeBrowser(info) && !isPhone(info)) return false // wait until we know
  return specRows(info).some((row) => row.mark === 'short')
}

/** The headline, matching the main reason. */
export function specsTitle(info: DeviceInfo): string {
  if (isPhone(info)) return 'Cloak works best on a laptop'
  if (!isChromeBrowser(info)) return 'Cloak works best in Chrome'
  return 'Cloak may be slower on this laptop'
}

// Bump the version when the notice changes enough to show it again.
const SEEN_KEY = 'cloak.specsSeen'
const SEEN_VERSION = '1'

export function specsSeen(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SEEN_KEY) === SEEN_VERSION
  } catch {
    return false
  }
}

export function markSpecsSeen(storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SEEN_KEY, SEEN_VERSION)
  } catch {
    // Not remembered: it may show again next visit.
  }
}
