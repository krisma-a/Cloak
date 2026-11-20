// Developer-only smoke test. Open http://localhost:5173/smoke.html while `npm run dev` runs.
// It is not linked from the app and is not included in `npm run build`.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getToken } from 'firebase/app-check'
import { appCheck, CLOUD_MODEL, ensureSignedIn, getDraftingModel, getRedactionModel } from './firebase'

const PROMPT = 'Reply with the single word OK.'

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function SmokeTest() {
  const [lines, setLines] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const log = (m: string) => setLines((prev) => [...prev, m])

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true)
    log(`> ${label}`)
    const start = performance.now()
    try {
      await fn()
    } catch (e) {
      log(`  FAILED ${describe(e)}`)
    } finally {
      log(`  took ${((performance.now() - start) / 1000).toFixed(1)} s`)
      setBusy(false)
    }
  }

  // Times the App Check exchange on its own (debug token -> App Check token).
  // The token itself is never shown.
  const token = () =>
    run('Get App Check token (fresh)', async () => {
      if (!appCheck) throw new Error('App Check is not set up: VITE_RECAPTCHA_SITE_KEY is missing')
      const result = await getToken(appCheck, true)
      log(`  OK got a token (${result.token.length} characters)`)
    })

  const signIn = () =>
    run('Sign in anonymously', async () => {
      const user = await ensureSignedIn()
      log(`  OK signed in, uid ${user.uid.slice(0, 6)}... (anonymous: ${user.isAnonymous})`)
    })

  const cloud = () =>
    run(`Cloud call (${CLOUD_MODEL})`, async () => {
      await ensureSignedIn()
      const result = await getDraftingModel().generateContent(PROMPT)
      log(`  OK reply: ${result.response.text().trim()}`)
      log(`  ran: ${result.response.inferenceSource ?? 'unknown'}`)
    })

  const onDevice = () =>
    run('On-device call (Gemini Nano)', async () => {
      await ensureSignedIn()
      const model = getRedactionModel()
      // Must run from a click: this may download the model the first time.
      await model.initializeDeviceModel((p) => log(`  download ${Math.round(p * 100)}%`))
      const result = await model.generateContent(PROMPT)
      log(`  OK reply: ${result.response.text().trim()}`)
      log(`  ran: ${result.response.inferenceSource ?? 'unknown'}`)
    })

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 720 }}>
      <h1>Cloak smoke test</h1>
      <p>Run these in order. Fake data only.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={token}>0. App Check token</button>
        <button disabled={busy} onClick={signIn}>1. Sign in</button>
        <button disabled={busy} onClick={cloud}>2. Cloud call</button>
        <button disabled={busy} onClick={onDevice}>3. On-device call</button>
        <button disabled={busy} onClick={() => setLines([])}>Clear</button>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16 }}>{lines.join('\n')}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<SmokeTest />)
