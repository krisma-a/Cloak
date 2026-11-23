import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { expectPolicyLoad } from './policy.ts'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
