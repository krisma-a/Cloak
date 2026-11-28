// Firebase Analytics, counts only. The thin Firebase part: what may be logged is decided in analyticsEvents.ts
// (pure, tested). Nothing here ever sees a note, a name or a file name.
//
// - Loaded on the first event, never with the first screen. If anything fails, it is silent: the app works the same.
// - Off in `npm run dev`, so test clicks don't count as real use.
// - No automatic page_view, no Google Signals, no ad personalisation. Firebase still sends its own standard
//   usage events (like session_start); those carry no case content either.

import { buildAnalyticsEvent } from './analyticsEvents.ts'
import type { AnalyticsEventName } from './analyticsEvents.ts'

let ready: Promise<((name: string, params: Record<string, string | number>) => void) | null> | null = null

function start() {
  ready ??= (async () => {
    if (import.meta.env.DEV) return null
    try {
      const [analytics, { app }] = await Promise.all([import('firebase/analytics'), import('./firebase.ts')])
      if (!import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || !(await analytics.isSupported())) return null
      const instance = analytics.initializeAnalytics(app, {
        config: { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false },
      })
      analytics.setConsent({ ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
      return (name, params) => analytics.logEvent(instance, name, params)
    } catch {
      return null
    }
  })()
  return ready
}

/** Logs one of the five count-only events. Never awaited, never throws. */
export function track(name: AnalyticsEventName, params: Record<string, unknown> = {}): void {
  const event = buildAnalyticsEvent(name, params)
  if (!event) return
  void start()
    .then((log) => log?.(event.name, event.params))
    .catch(() => undefined)
}
