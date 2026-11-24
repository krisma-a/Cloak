import { useEffect, useMemo, useState } from 'react'
import {
  groupUsage,
  PRICE_VERSION,
  PRICES,
  totalUsage,
  usageTimeline,
  type UsageBucket,
  type UsageGroup,
  type UsageRow,
} from '../ai/usage.ts'
import './usage.css'

// Hidden page at /usage (not linked from the app). A live board of every model call: tokens in and out,
// where it ran, and what it would cost on the paid tier. Records hold numbers and fixed labels only
// (see src/ai/usage.ts), never case text, so this page can show everyone's calls.

type Range = 'hour' | 'day' | 'week' | 'all'
type Origin = 'all' | 'app' | 'eval'

const RANGES: Record<Range, { label: string; ms: number | null; bucket: number }> = {
  hour: { label: 'Last hour', ms: 3_600_000, bucket: 120_000 },
  day: { label: 'Last 24 hours', ms: 86_400_000, bucket: 3_600_000 },
  week: { label: 'Last 7 days', ms: 7 * 86_400_000, bucket: 6 * 3_600_000 },
  all: { label: 'Everything loaded', ms: null, bucket: 86_400_000 },
}

const LABELS: Record<string, string> = {
  redact: 'Redaction',
  restrictions: 'Work restrictions',
  'tag-case-type': 'Case type',
  'rewrite-tone': 'Tone rewrite',
  draft: 'Cloud draft',
}

const usd = (n: number): string => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
const num = (n: number): string => n.toLocaleString('en-US')
const short = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : num(n))
const time = (t: number | null, withDate = false): string =>
  t === null ? 'just now' : new Date(t).toLocaleString('en-US', withDate ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' })

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  )
}

/** Stacked bars per time bucket: cloud tokens on the bottom, on-device on top. Hover a bar for numbers. */
function TokenTimeline({ buckets, bucketMs }: { buckets: UsageBucket[]; bucketMs: number }) {
  const [hover, setHover] = useState<number | null>(null)
  if (buckets.length === 0) return <p className="muted">No calls in this range yet.</p>
  const W = 720
  const H = 220
  const pad = { top: 12, right: 8, bottom: 26, left: 48 }
  const max = Math.max(1, ...buckets.map((b) => b.cloudTokens + b.onDeviceTokens))
  const innerW = W - pad.left - pad.right
  const innerH = H - pad.top - pad.bottom
  const slot = innerW / buckets.length
  const barW = Math.max(2, Math.min(28, slot - 4))
  const y = (v: number) => pad.top + innerH - (v / max) * innerH
  const ticks = [0, max / 2, max]
  const every = Math.ceil(buckets.length / 6)
  const withDate = bucketMs >= 86_400_000 || buckets.length * bucketMs > 86_400_000
  const hovered = hover === null ? null : buckets[hover]

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens per time period, cloud and on-device" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.left - 6} y={y(t) + 4} textAnchor="end">{short(Math.round(t))}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = pad.left + i * slot + (slot - barW) / 2
          const cloudTop = y(b.cloudTokens)
          const allTop = y(b.cloudTokens + b.onDeviceTokens)
          const gap = b.cloudTokens > 0 && b.onDeviceTokens > 0 ? 2 : 0
          return (
            <g key={b.start} onMouseEnter={() => setHover(i)}>
              <rect className="hit" x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} />
              {b.cloudTokens > 0 && <rect className="s-cloud" x={x} y={cloudTop} width={barW} height={y(0) - cloudTop} rx={Math.min(3, barW / 2)} />}
              {b.onDeviceTokens > 0 && (
                <rect className="s-device" x={x} y={allTop} width={barW} height={Math.max(1, cloudTop - allTop - gap)} rx={Math.min(3, barW / 2)} />
              )}
              {i % every === 0 && (
                <text className="axis" x={x + barW / 2} y={H - 8} textAnchor="middle">{time(b.start, withDate)}</text>
              )}
            </g>
          )
        })}
        {hovered && hover !== null && (
          <line className="crosshair" x1={pad.left + hover * slot + slot / 2} x2={pad.left + hover * slot + slot / 2} y1={pad.top} y2={pad.top + innerH} />
        )}
      </svg>
      {hovered && (
        <div className="tooltip" role="status">
          <strong>{time(hovered.start, true)}</strong>
          <span><i className="key s-cloud" /> Cloud {num(hovered.cloudTokens)} tokens</span>
          <span><i className="key s-device" /> On device {num(hovered.onDeviceTokens)} tokens</span>
          <span>{num(hovered.calls)} calls · {usd(hovered.costUsd)}</span>
        </div>
      )}
      <div className="legend">
        <span><i className="key s-cloud" /> Cloud tokens (billed)</span>
        <span><i className="key s-device" /> On-device tokens (free, estimated)</span>
      </div>
    </div>
  )
}

/** One horizontal bar per group, sorted by cost, labelled with tokens and cost. */
function GroupBars({ groups, labelOf }: { groups: UsageGroup[]; labelOf: (key: string) => string }) {
  if (groups.length === 0) return <p className="muted">Nothing yet.</p>
  const max = Math.max(1, ...groups.map((g) => g.totalTokens))
  return (
    <ul className="hbars">
      {groups.map((g) => (
        <li key={g.key} title={`${num(g.calls)} calls · ${num(g.totalTokens)} tokens · ${usd(g.costUsd)}`}>
          <span className="hbar-label">{labelOf(g.key)}</span>
          <span className="hbar-track">
            <span className={`hbar ${g.cloudCalls > 0 ? 's-cloud' : 's-device'}`} style={{ width: `${Math.max(1, (g.totalTokens / max) * 100)}%` }} />
          </span>
          <span className="hbar-value">
            {short(g.totalTokens)} tokens · <strong>{usd(g.costUsd)}</strong>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function UsagePage() {
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('day')
  const [origin, setOrigin] = useState<Origin>('all')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    import('../ai/usageStore.ts')
      .then((m) => m.watchUsage(setRows, (code) => setError(code === 'permission-denied' ? 'The database refused to share usage records (are the latest Firestore rules deployed?).' : `Could not load usage (${code}).`)))
      .then((unsubscribe) => (cancelled ? unsubscribe() : (stop = unsubscribe)))
      .catch((e: unknown) => setError(`Could not connect: ${e instanceof Error ? e.message : 'unknown error'}`))
    const timer = setInterval(() => setNow(Date.now()), 30_000) // keeps "last hour" sliding
    return () => {
      cancelled = true
      stop?.()
      clearInterval(timer)
    }
  }, [])

  const view = useMemo(() => {
    const span = RANGES[range].ms
    return (rows ?? []).filter(
      (r) => (origin === 'all' || r.origin === origin) && (span === null || r.createdAt === null || r.createdAt >= now - span),
    )
  }, [rows, range, origin, now])

  const totals = totalUsage(view)
  const drafts = view.filter((r) => r.label === 'draft')
  const draftCost = totalUsage(drafts)
  const buckets = usageTimeline(view, RANGES[range].bucket, 60)

  return (
    <main className="usage-page">
      <header className="row between">
        <div>
          <h1>Cloak usage</h1>
          <p className="lead">
            Every model call, live: tokens in and out, where it ran, and what it would cost on the paid tier. Numbers only, no case
            text.
          </p>
        </div>
        <span className={`live ${rows && !error ? 'on' : ''}`}>{error ? 'Offline' : rows ? 'Live' : 'Connecting…'}</span>
      </header>

      <div className="filters" role="group" aria-label="Filters">
        <label>
          Time
          <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {Object.entries(RANGES).map(([key, r]) => (
              <option key={key} value={key}>{r.label}</option>
            ))}
          </select>
        </label>
        <label>
          Calls from
          <select value={origin} onChange={(e) => setOrigin(e.target.value as Origin)}>
            <option value="all">The app and /eval</option>
            <option value="app">The app only</option>
            <option value="eval">/eval only</option>
          </select>
        </label>
        <span className="muted">{rows ? `${num(view.length)} of ${num(rows.length)} loaded calls` : ''}</span>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="tiles" aria-label="Totals">
        <Tile label="Equivalent cost" value={usd(totals.costUsd)} note={totals.unpricedCalls ? `${totals.unpricedCalls} calls have no listed price` : 'paid-tier price; free tier bills $0'} />
        <Tile label="Cloud tokens" value={short(totals.cloudTokens)} note={`${num(totals.cloudCalls)} cloud calls · ${short(totals.thinkingTokens)} thinking`} />
        <Tile label="On-device tokens" value={short(totals.totalTokens - totals.cloudTokens)} note={`${num(totals.onDeviceCalls)} calls on this laptop · $0`} />
        <Tile label="Avg per cloud draft" value={drafts.length ? usd(draftCost.costUsd / drafts.length) : '—'} note={drafts.length ? `${num(Math.round(draftCost.totalTokens / drafts.length))} tokens each · ${num(drafts.length)} drafts` : 'no drafts yet'} />
      </section>

      <section className="card" aria-labelledby="timeline-title">
        <h2 id="timeline-title">Tokens over time</h2>
        <TokenTimeline buckets={buckets} bucketMs={RANGES[range].bucket} />
      </section>

      <div className="two-col">
        <section className="card" aria-labelledby="steps-title">
          <h2 id="steps-title">By step</h2>
          <GroupBars groups={groupUsage(view, 'label')} labelOf={(k) => LABELS[k] ?? k} />
        </section>
        <section className="card" aria-labelledby="models-title">
          <h2 id="models-title">By model</h2>
          <GroupBars groups={groupUsage(view, 'model')} labelOf={(k) => (k === 'gemini-nano' ? 'Gemini Nano (on device)' : k)} />
        </section>
      </div>

      <section className="card" aria-labelledby="calls-title">
        <h2 id="calls-title">Latest calls</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Step</th>
                <th scope="col">From</th>
                <th scope="col">Model</th>
                <th scope="col">Where</th>
                <th scope="col" className="num">In</th>
                <th scope="col" className="num">Out</th>
                <th scope="col" className="num">Thinking</th>
                <th scope="col" className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {view.slice(0, 100).map((r) => (
                <tr key={r.id}>
                  <td>{time(r.createdAt, true)}</td>
                  <td>{LABELS[r.label] ?? r.label}</td>
                  <td>{r.origin === 'eval' ? '/eval' : 'App'}</td>
                  <td>{r.model}</td>
                  <td>{r.ranOn === 'in_cloud' ? 'Cloud' : 'On device'}</td>
                  <td className="num">{num(r.inputTokens)}{r.estimated ? '*' : ''}</td>
                  <td className="num">{num(r.outputTokens)}{r.estimated ? '*' : ''}</td>
                  <td className="num">{num(r.thinkingTokens)}</td>
                  <td className="num">{r.costUsd === null ? 'no price' : usd(r.costUsd)}</td>
                </tr>
              ))}
              {view.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">No calls in this range yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          * Estimated from length (about 4 characters a token): Gemini Nano does not report token counts. Prices checked{' '}
          {PRICE_VERSION}:{' '}
          {Object.entries(PRICES).map(([model, p]) => `${model} $${p.inputPerM} in / $${p.outputPerM} out per 1M tokens (thinking billed as output)`).join('; ')}.
          Google lists a lower introductory price until 2026-12-31.
        </p>
      </section>
    </main>
  )
}
