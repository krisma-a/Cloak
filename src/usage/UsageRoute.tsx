import { lazy, Suspense } from 'react'
import { ErrorBoundary, LoadingPage } from '../workspace/PageStates.tsx'

// The usage dashboard's code is only downloaded when /usage is opened (like /eval).
const UsagePage = lazy(() => import('./UsagePage.tsx').then((m) => ({ default: m.UsagePage })))

export function UsageRoute() {
  return (
    <ErrorBoundary note="The usage page didn’t load. Check your internet connection, then reload.">
      <Suspense fallback={<LoadingPage title="Opening the usage dashboard…" note="This only takes a moment." />}>
        <UsagePage />
      </Suspense>
    </ErrorBoundary>
  )
}
