import { useEffect, useRef, useState } from 'react'
import { downloadTextFile } from '../download.ts'
import { buildPipelines } from './pipelines.ts'
import { runEval } from './runner.ts'
import { parseCaseSet, type CaseSet, type EvalReport, type PipelineSummary } from './score.ts'
import './eval.css'

// Hidden page at /eval (not linked from the app). It scores three redaction pipelines on Set B, the fake
// holdout notes in data/cases/set-b.json, and exports the results. FAKE DATA ONLY: it loads that one file
// and nothing else, so no real case note can end up here or in the exported JSON.

const pct = (value: number | null): string => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
const ms = (value: number | null): string =>
  value === null ? '—' : value < 10 ? `${value.toFixed(2)} ms` : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`

function Bar({ value }: { value: number }) {
  return (
    <span className="bar" aria-hidden="true">
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  )
}

function SummaryTable({ pipelines }: { pipelines: PipelineSummary[] }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Results for each pipeline</caption>
        <thead>
          <tr>
            <th scope="col">Pipeline</th>
            <th scope="col" className="num">Catch rate</th>
            <th scope="col" className="num">Leaked after blocking</th>
            <th scope="col" className="num">Block rate</th>
            <th scope="col" className="num">Avg on-device time</th>
            <th scope="col" className="num">Avg cloud time</th>
            <th scope="col" className="num">Over-redacted</th>
          </tr>
        </thead>
        <tbody>
          {pipelines.map((p) =>
            p.skipped !== null ? (
              <tr key={p.id}>
                <th scope="row">{p.label}</th>
                <td colSpan={6} className="muted">Skipped: {p.skipped}</td>
              </tr>
            ) : (
              <tr key={p.id}>
                <th scope="row">
                  {p.label}
                  <span className="sub">
                    {Object.entries(p.engines).map(([engine, n]) => `${engine} × ${n}`).join(', ')}
                    {p.failed > 0 ? ` · ${p.failed} failed` : ''}
                    {p.avgAttempts !== null && p.hasBlocking ? ` · ${p.avgAttempts.toFixed(2)} passes per note` : ''}
                  </span>
                </th>
                <td className="num">
                  <strong>{pct(p.catchRate)}</strong>
                  <span className="sub">{p.caught} of {p.planted} items</span>
                </td>
                <td className="num">
                  {p.leakedAfterBlocking}
                  <span className="sub">of {p.planted - p.caught} missed</span>
                </td>
                <td className="num">
                  {p.blockRate === null ? <span className="muted">no blocking</span> : pct(p.blockRate)}
                  {p.blockRate !== null && <span className="sub">{p.blocked} of {p.scored} notes</span>}
                </td>
                <td className="num">{ms(p.avgOnDeviceMs)}</td>
                <td className="num">
                  {p.avgCloudMs === null ? <span className="muted">not measured</span> : ms(p.avgCloudMs)}
                  {p.avgCloudMs !== null && (
                    <span className="sub">
                      {p.cloudSamples} {p.cloudSamples === 1 ? 'call' : 'calls'}
                      {p.cloudErrors > 0 ? `, ${p.cloudErrors} failed` : ''}
                    </span>
                  )}
                </td>
                <td className="num">
                  {p.overRedacted}
                  <span className="sub">of {p.keepTotal} kept texts</span>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}

function CategoryTable({ pipelines }: { pipelines: PipelineSummary[] }) {
  const ran = pipelines.filter((p) => p.skipped === null)
  const types = [...new Set(ran.flatMap((p) => p.byCategory.map((c) => c.type)))]
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Catch rate per category and pipeline</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            {ran.map((p) => (
              <th scope="col" key={p.id} className="num">{p.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {types.map((type) => (
            <tr key={type}>
              <th scope="row">{type}</th>
              {ran.map((p) => {
                const stat = p.byCategory.find((c) => c.type === type)
                return (
                  <td key={p.id} className="num">
                    {stat ? (
                      <>
                        <Bar value={stat.rate} />
                        {pct(stat.rate)}
                        <span className="sub">{stat.caught} of {stat.planted}</span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MissList({ report }: { report: EvalReport }) {
  const ran = report.pipelines.filter((p) => p.skipped === null)
  const [pipeline, setPipeline] = useState<string>(ran.at(-1)?.id ?? 'all')
  const rows = ran.filter((p) => pipeline === 'all' || p.id === pipeline).flatMap((p) => p.misses)
  const labels = Object.fromEntries(report.pipelines.map((p) => [p.id, p.label]))

  return (
    <>
      <div className="row">
        <label htmlFor="miss-filter">Show misses from</label>
        <select id="miss-filter" value={pipeline} onChange={(e) => setPipeline(e.target.value)}>
          {ran.map((p) => (
            <option key={p.id} value={p.id}>{p.label} ({p.misses.length})</option>
          ))}
          <option value="all">All pipelines ({ran.reduce((n, p) => n + p.misses.length, 0)})</option>
        </select>
        <span className="muted">{rows.length} {rows.length === 1 ? 'miss' : 'misses'}</span>
      </div>
      <div className="table-wrap tall" tabIndex={0} role="region" aria-label="Every missed item">
        <table>
          <thead>
            <tr>
              <th scope="col">Note</th>
              {pipeline === 'all' && <th scope="col">Pipeline</th>}
              <th scope="col">Category</th>
              <th scope="col">Missed item (fake data)</th>
              <th scope="col">Why</th>
              <th scope="col">Note blocked?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={`${m.pipeline}-${m.noteId}-${i}`}>
                <td>{m.noteId}</td>
                {pipeline === 'all' && <td>{labels[m.pipeline]}</td>}
                <td>{m.type}</td>
                <td className="item">{m.text}</td>
                <td>{m.reason === 'visible' ? 'Still visible' : `Part still visible: ${m.leftover ?? ''}`}</td>
                <td>{m.noteBlocked ? 'Yes, not sent' : 'No'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">No misses.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function EvalPage() {
  const [set, setSet] = useState<CaseSet | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(60)
  const [cloudOn, setCloudOn] = useState(false)
  const [cloudSample, setCloudSample] = useState(5)
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'running'>('idle')
  const [prepared, setPrepared] = useState<number | null>(null)
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null)
  const [report, setReport] = useState<EvalReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logStatus, setLogStatus] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  // Set B is the only file this page loads: fake notes with their answer key.
  useEffect(() => {
    import('../../data/cases/set-b.json')
      .then((module) => {
        const loaded = parseCaseSet(module.default)
        setSet(loaded)
        setLimit(loaded.notes.length)
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Could not load Set B.'))
  }, [])

  const planted = set?.notes.reduce((sum, n) => sum + n.planted.length, 0) ?? 0
  const busy = phase !== 'idle'

  async function run() {
    if (!set) return
    const controller = new AbortController()
    abort.current = controller
    setError(null)
    setReport(null)
    setPrepared(null)
    setPhase('preparing') // loading the on-device models; the first time Gemini Nano can download
    try {
      const built = await buildPipelines({ cloudSample: cloudOn ? cloudSample : 0, onProgress: setPrepared })
      setPhase('running')
      const labels = Object.fromEntries(built.pipelines.map((p) => [p.id, p.label]))
      setReport(
        await runEval({
          set,
          limit,
          pipelines: built.pipelines,
          context: built.context,
          signal: controller.signal,
          onProgress: (p) => setProgress({ label: labels[p.pipeline] ?? p.pipeline, done: p.done, total: p.total }),
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : 'The run failed.')
    } finally {
      setPhase('idle')
      setProgress(null)
      abort.current = null
    }
  }

  function exportJson() {
    if (!report) return
    const stamp = report.generatedAt.slice(0, 19).replaceAll(':', '-')
    downloadTextFile(`cloak-eval-set-${report.set.toLowerCase()}-${stamp}.json`, `${JSON.stringify(report, null, 2)}\n`, 'application/json')
  }

  async function downloadCsv() {
    setLogStatus('Getting your send log…')
    try {
      const { downloadMySendLogsCsv } = await import('../ai/sendLogStore.ts')
      const rows = await downloadMySendLogsCsv()
      setLogStatus(rows === 0 ? 'No sends are logged for this user yet. The file has only the header row.' : `Saved ${rows} ${rows === 1 ? 'row' : 'rows'}.`)
    } catch (e) {
      setLogStatus(`Could not download the log: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  }

  return (
    <main className="eval-page">
      <header>
        <h1>Cloak eval</h1>
        <p className="lead">
          Scores three redaction pipelines on Set B, a holdout of fake notes with every private detail marked. A detail counts as
          caught when its text is gone from the output. Fake data only.
        </p>
      </header>

      <section className="card" aria-labelledby="run-title">
        <h2 id="run-title">Run</h2>
        {loadError && <p className="alert" role="alert">{loadError}</p>}
        {!set && !loadError && <p className="muted">Loading Set B…</p>}
        {set && (
          <>
            <p>
              Set {set.meta.set}: <strong>{set.notes.length} notes</strong>, <strong>{planted} planted items</strong>
              {set.meta.seed !== null ? `, seed ${set.meta.seed}` : ''}.
            </p>
            <dl className="pipelines">
              <div><dt>Regex only</dt><dd>Rules for emails, phones, IDs, salary and medical keywords. No model.</dd></div>
              <div><dt>On-device model only</dt><dd>One Gemini Nano pass. No name cross-check, retries or blocking.</dd></div>
              <div><dt>Full Cloak</dt><dd>Nano or the backup engine, name cross-check, retries, then the send guard that can block a note.</dd></div>
            </dl>
            <div className="controls">
              <label>
                Notes to run
                <input type="number" min={1} max={set.notes.length} value={limit} disabled={busy}
                  onChange={(e) => setLimit(Math.min(set.notes.length, Math.max(1, Number(e.target.value) || 1)))} />
              </label>
              <label className="check">
                <input type="checkbox" checked={cloudOn} disabled={busy} onChange={(e) => setCloudOn(e.target.checked)} />
                Also time the cloud draft
              </label>
              {cloudOn && (
                <label>
                  For the first
                  <input type="number" min={1} max={set.notes.length} value={cloudSample} disabled={busy}
                    onChange={(e) => setCloudSample(Math.min(set.notes.length, Math.max(1, Number(e.target.value) || 1)))} />
                  notes the full pipeline lets through
                </label>
              )}
            </div>
            {cloudOn && (
              <p className="hint">
                This sends the hidden version of those fake notes to the cloud model. It does not touch your receipts or send log.
              </p>
            )}
            <div className="row">
              <button type="button" className="primary" onClick={run} disabled={busy}>
                {phase === 'preparing' ? 'Loading models…' : phase === 'running' ? 'Running…' : 'Run eval'}
              </button>
              {busy && (
                <button type="button" onClick={() => abort.current?.abort()} disabled={phase !== 'running'}>Stop</button>
              )}
              <span role="status" className="muted">
                {phase === 'preparing' && `Getting the on-device models ready${prepared !== null ? `… ${Math.round(prepared * 100)}%` : '…'}`}
                {progress && `${progress.label}: ${progress.done} of ${progress.total} notes`}
              </span>
            </div>
          </>
        )}
        {error && <p className="alert" role="alert">{error}</p>}
      </section>

      {report && (
        <>
          <section className="card" aria-labelledby="results-title">
            <div className="row between">
              <h2 id="results-title">Results</h2>
              <button type="button" className="primary" onClick={exportJson}>Download JSON</button>
            </div>
            <p className="muted">
              {report.notesRun} of {report.notesInSet} notes{report.stopped ? ', stopped early' : ''}. Full pipeline engine:{' '}
              <strong>{String(report.context.fullPipelineEngine ?? 'unknown')}</strong>
              {report.context.nanoAvailable === false ? ' (Gemini Nano was not available in this browser)' : ''}.
            </p>
            <SummaryTable pipelines={report.pipelines} />
            <h3>Catch rate by category</h3>
            <CategoryTable pipelines={report.pipelines} />
          </section>

          <section className="card" aria-labelledby="misses-title">
            <h2 id="misses-title">Every miss</h2>
            <MissList report={report} />
          </section>
        </>
      )}

      <section className="card" aria-labelledby="log-title">
        <h2 id="log-title">My send log</h2>
        <p className="muted">
          Every send saves counts only (how many details of each kind, blocked or not, the settings version, the model, where each
          step ran, your user id) and never any text. You can only read your own.
        </p>
        <div className="row">
          <button type="button" onClick={downloadCsv}>Download CSV</button>
          <span role="status" className="muted">{logStatus}</span>
        </div>
      </section>
    </main>
  )
}
