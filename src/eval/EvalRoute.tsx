import { lazy, Suspense } from 'react'
import { ErrorBoundary, LoadingPage } from '../workspace/PageStates.tsx'

// The eval page's code is only downloaded when /eval is opened. While it arrives the person sees a loading
// message, and if the download fails they see an error message instead of a blank page.
const EvalPage = lazy(() => import('./EvalPage.tsx').then((m) => ({ default: m.EvalPage })))

export function EvalRoute() {
  return (
    <ErrorBoundary note="The eval page didn’t load. Check your internet connection, then reload.">
      <Suspense fallback={<LoadingPage title="Opening the eval page…" note="This only takes a moment." />}>
        <EvalPage />
      </Suspense>
    </ErrorBoundary>
  )
}
