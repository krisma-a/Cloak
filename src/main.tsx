import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { EvalRoute } from './eval/EvalRoute.tsx'
import { expectPolicyLoad } from './policy.ts'
import { ErrorBoundary } from './workspace/PageStates.tsx'

// Fetch the Remote Config settings (redact_salary, medical_mode, max_retries, cloud_model) as the page
// loads. Loaded lazily so the first screen never waits on Firebase. If anything fails (no .env.local,
// offline), the built-in defaults stay in force and the app works as before.
expectPolicyLoad(
  import('./remoteConfig.ts')
    .then((m) => m.startRemoteConfig())
    .catch((e: unknown) => {
      console.warn('[policy] Remote Config not loaded; using built-in values:', e instanceof Error ? e.message : e)
    }),
)

const root = createRoot(document.getElementById('root')!)

// /eval is a hidden page for scoring the redaction pipelines on fake data. Nothing links to it, and its code
// is only downloaded when this path is opened (see EvalRoute, which also covers loading and a failed download).
// (Firebase Hosting sends every path to index.html.)
if (location.pathname.replace(/\/+$/, '') === '/eval') {
  root.render(
    <StrictMode>
      <EvalRoute />
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}
