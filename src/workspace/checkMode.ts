// How the notes are checked: "full" (Full Cloak: Gemini Nano + safety net, recommended) or "basic" (the faster backup
// engine for slow laptops: in-browser name model + rules, which catches less). Pure, so tests run in Node.
// The choice is remembered in this browser only (a convenience, not a setting): it never leaves the laptop.

export type CheckMode = 'full' | 'basic'

const KEY = 'cloak.checkMode'

/** Anything that is not exactly "basic" means Full Cloak, so a lost or odd value falls back to the safer choice. */
export function parseCheckMode(raw: string | null | undefined): CheckMode {
  return raw === 'basic' ? 'basic' : 'full'
}

export function loadCheckMode(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): CheckMode {
  try {
    return parseCheckMode(storage?.getItem(KEY))
  } catch {
    return 'full' // storage blocked (private window, site data off)
  }
}

export function saveCheckMode(mode: CheckMode, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, mode)
  } catch {
    // Not remembered; the choice still applies to this visit.
  }
}
