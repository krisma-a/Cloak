// Developer-only smoke test. Open http://localhost:5173/smoke.html while `npm run dev` runs.
// It is not linked from the app and is not included in `npm run build`.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getToken } from 'firebase/app-check'
import { appCheck, CLOUD_MODEL, ensureSignedIn, getDraftingModel, getRedactionModel } from './firebase'
import { prepareRedaction, redact, type EngineChoice } from './ai/redact'
import { restore } from './ai/placeholders'

const PROMPT = 'Reply with the single word OK.'

// FAKE case note for testing. Every name, number and detail here is made up.
const SAMPLE_NOTE = `Case 24-117. Maria Santos (EMP-40912) reported that her supervisor, Chidi Okafor, mocked her accent in the Oct 3 team meeting. Maria can be reached at maria.santos@example.com or (555) 201-7788. She has type 2 diabetes and needs a short break every 2 hours. Salary: $68,500. Witness: Nguyen Thi Lan, the only woman on the night warehouse crew. SSN on file: 123-45-6789.`

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function SmokeTest() {
  const [lines, setLines] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(SAMPLE_NOTE)
  const [engineChoice, setEngineChoice] = useState<EngineChoice>('auto')
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

  // Redaction runs only on this laptop. The note text is never sent to the cloud here.
  const redactNote = () =>
    run(`Redact note (on this device, engine: ${engineChoice})`, async () => {
      let lastTenth = -1
      const { engine, note: why } = await prepareRedaction((p) => {
        const tenth = Math.floor(p * 10)
        if (tenth !== lastTenth) {
          lastTenth = tenth
          log(`  loading model ${tenth * 10}%`)
        }
      }, engineChoice)
      log(`  engine: ${engine}`)
      if (why) log(`  note: ${why}`)
      const result = await redact(note, { engine })
      log(`  status: ${result.status}   engine: ${result.engine}   attempts: ${result.attempts}   ran: ${result.ranOn}`)
      if (result.crossCheck) {
        log(`  name cross-check: ${result.crossCheck.ran ? `ran, hid ${result.crossCheck.added} item(s) Nano missed` : 'skipped'}`)
      }
      if (result.note) log(`  note: ${result.note}`)
      if (result.needsCarefulReview) log('  review: backup engine used, user must check carefully')
      log(`  counts: ${JSON.stringify(result.counts)}`)
      if (result.leaks.length) {
        log(`  still leaking: ${result.leaks.map((l) => `${l.category} "${l.text}"`).join(', ')}`)
      }
      if (result.redactedText) {
        log('  --- what the cloud would see ---')
        log(`  ${result.redactedText}`)
        log('  --- placeholder map (stays in the browser) ---')
        for (const [ph, original] of Object.entries(result.map.originals)) log(`  ${ph} = ${original}`)
        log('  --- restore check (placeholders swapped back, in the browser) ---')
        log(`  ${restore(result.redactedText, result.map)}`)
      }
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
      <h2 style={{ fontSize: 18, marginTop: 24 }}>Redaction (on-device)</h2>
      <p>Fake data only. This text is processed on this device and never sent to the cloud.</p>
      <label>
        Engine:{' '}
        <select
          value={engineChoice}
          disabled={busy}
          onChange={(e) => setEngineChoice(e.target.value as EngineChoice)}
        >
          <option value="auto">Auto (Gemini Nano if available, else backup)</option>
          <option value="browser-model">Backup: in-browser model</option>
          <option value="rules-only">Backup: rules only</option>
        </select>
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={7}
        style={{ width: '100%', boxSizing: 'border-box', font: 'inherit' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button disabled={busy} onClick={redactNote}>4. Redact note</button>
        <button disabled={busy} onClick={() => setNote(SAMPLE_NOTE)}>Reset sample</button>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16 }}>{lines.join('\n')}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<SmokeTest />)
