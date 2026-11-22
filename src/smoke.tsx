// Developer-only smoke test. Open http://localhost:5173/smoke.html while `npm run dev` runs.
// It is not linked from the app and is not included in `npm run build`.

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getToken } from 'firebase/app-check'
import { appCheck, CLOUD_MODEL, ensureSignedIn, getDraftingModel, getRedactionModel } from './firebase'
import { prepareRedaction, redact, type EngineChoice, type RedactionResult } from './ai/redact'
import { restore } from './ai/placeholders'
import { draft } from './ai/draft'
import { confirmNoNames, hideNames, splitNames } from './ai/guard'
import { deriveRestrictions } from './ai/restrict'
import { accommodationBlockReason } from './ai/restrictionPrompt'
import { TEMPLATES, type TemplateId } from './ai/templates'

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
  const [lastRedaction, setLastRedaction] = useState<RedactionResult | null>(null)
  const [templateId, setTemplateId] = useState<TemplateId>('investigation')
  const [namesInput, setNamesInput] = useState('')
  const [restrictionsText, setRestrictionsText] = useState('')
  const [employee, setEmployee] = useState('')
  const log = (m: string) => setLines((prev) => [...prev, m])

  // Manager emails use ONLY these restrictions (one per line, edited and approved by the user).
  const employees = Object.entries(lastRedaction?.map.originals ?? {}).filter(([p]) => p.startsWith('[EMPLOYEE_'))
  const restrictionLines = restrictionsText.split('\n').map((l) => l.trim()).filter(Boolean)
  const needsRestrictions = TEMPLATES[templateId].input === 'restrictions'
  const planProblem = lastRedaction
    ? accommodationBlockReason({ employee, restrictions: restrictionLines }, lastRedaction.map, lastRedaction.redactedText)
    : 'Run 4. Redact note first.'

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
      setLastRedaction(result)
      setRestrictionsText('')
      const people = Object.keys(result.map.originals).filter((p) => p.startsWith('[EMPLOYEE_'))
      setEmployee(people.length === 1 ? people[0] : '')
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

  // Rules can't find names, so with the rules-only engine the user lists them (or confirms none).
  const hideTypedNames = () => {
    if (!lastRedaction) return
    const next = hideNames(lastRedaction, splitNames(namesInput))
    setLastRedaction(next)
    log('> Hide typed names (on this device)')
    log(`  status: ${next.status}   counts: ${JSON.stringify(next.counts)}`)
    log('  --- what the cloud would see now ---')
    log(`  ${next.redactedText}`)
  }
  const confirmNone = () => {
    if (!lastRedaction) return
    setLastRedaction(confirmNoNames(lastRedaction))
    log('> User confirmed there are no names left in the redacted text')
  }

  // Gemini Nano (on this device) suggests work restrictions; the original health details stay
  // in the map as [MEDICAL_DETAIL_n]. Nothing here is sent to the cloud.
  const findRestrictions = () =>
    run('Find work restrictions (on this device)', async () => {
      if (!lastRedaction) throw new Error('Run 4. Redact note first')
      const result = await deriveRestrictions(lastRedaction, (p) => log(`  loading model ${Math.round(p * 100)}%`))
      if (result.note) log(`  note: ${result.note}`)
      log(`  source: ${result.source}   suggested: ${result.items.length}   rejected by checks: ${result.dropped}`)
      for (const r of result.items) log(`  ${r.kind}: ${r.text}`)
      setRestrictionsText(result.items.map((r) => r.text).join('\n'))
    })

  // Sends ONLY the redacted text (after the guard) to cloud Gemini, then restores locally.
  // A manager email sends only the approved restrictions instead of the notes.
  const draftNote = () =>
    run(`Approve & draft (cloud): ${TEMPLATES[templateId].label}`, async () => {
      if (!lastRedaction) throw new Error('Run 4. Redact note first')
      const result = await draft(lastRedaction, templateId, {
        approved: true,
        accommodation: needsRestrictions ? { employee, restrictions: restrictionLines } : undefined,
      })
      if (needsRestrictions) {
        log('  --- what the cloud received (restrictions only) ---')
        log(result.receipt.sentText)
      }
      log('  --- receipt ---')
      log(`  model: ${result.receipt.model}   policy: ${result.receipt.policyVersion}   sent: ${result.receipt.sentAt}`)
      log(`  sha256: ${result.receipt.sha256}`)
      for (const s of result.receipt.steps) log(`  ${s.step}: ${s.ranOn}${s.detail ? ` (${s.detail})` : ''}`)
      for (const w of result.warnings) log(`  warning: ${w}`)
      log('  --- draft from the cloud (placeholders) ---')
      log(result.draftWithPlaceholders)
      log('  --- final draft (restored on this device) ---')
      log(result.restoredDraft)
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
      <h2 style={{ fontSize: 18, marginTop: 24 }}>Drafting (cloud, redacted text only)</h2>
      <label>
        Template:{' '}
        <select
          value={templateId}
          disabled={busy}
          onChange={(e) => setTemplateId(e.target.value as TemplateId)}
        >
          {Object.values(TEMPLATES).map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>
      {lastRedaction?.names === 'unchecked' && (
        <div style={{ marginTop: 12, padding: 8, border: '1px solid #c60' }}>
          <strong>Names have not been checked.</strong> This engine can&apos;t find names. List every
          person&apos;s name in the note (comma separated), or confirm there are none.
          <input
            value={namesInput}
            onChange={(e) => setNamesInput(e.target.value)}
            placeholder="Maria Santos, Chidi Okafor"
            style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0' }}
          />
          <button disabled={busy || !splitNames(namesInput).length} onClick={hideTypedNames}>
            Hide these names
          </button>{' '}
          <button disabled={busy} onClick={confirmNone}>There are no names in the text</button>
        </div>
      )}
      {needsRestrictions && lastRedaction?.status === 'ok' && (
        <div style={{ marginTop: 12, padding: 8, border: '1px solid #06c' }}>
          <strong>Work restrictions for the manager.</strong> The email uses only these lines. No
          diagnosis and none of the case notes are sent. Edit them, then approve.
          <div style={{ margin: '8px 0' }}>
            <button disabled={busy} onClick={findRestrictions}>4b. Find work restrictions (Gemini Nano)</button>
          </div>
          <label>
            Employee:{' '}
            <select value={employee} disabled={busy} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">Choose…</option>
              {employees.map(([p, name]) => (
                <option key={p} value={p}>{p} = {name}</option>
              ))}
            </select>
          </label>
          <textarea
            value={restrictionsText}
            onChange={(e) => setRestrictionsText(e.target.value)}
            rows={4}
            placeholder="One restriction per line, e.g. a short break every 2 hours"
            style={{ width: '100%', boxSizing: 'border-box', font: 'inherit', marginTop: 8 }}
          />
          {planProblem && <small>{planProblem}</small>}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button
          disabled={
            busy || lastRedaction?.status !== 'ok' || lastRedaction.names === 'unchecked' ||
            (needsRestrictions && planProblem !== null)
          }
          onClick={draftNote}
        >
          5. Approve &amp; draft
        </button>{' '}
        {lastRedaction?.status !== 'ok' && <small>Run 4. Redact note first (status must be ok).</small>}
        {lastRedaction?.status === 'ok' && lastRedaction.names === 'unchecked' && (
          <small>Check names first (above).</small>
        )}
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', marginTop: 16 }}>{lines.join('\n')}</pre>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<SmokeTest />)
