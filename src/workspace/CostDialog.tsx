import { useEffect, useMemo, useRef, useState } from 'react'
import { PRICE_VERSION } from '../ai/usage.ts'
import type { UsageEvent } from '../ai/usage.ts'
import { clearHistory, formatTokens, formatUsd, loadHistory, monthlyCost, receiptLines, summarizeHistory } from './draftCost.ts'

/** A typical draft's cost when nothing has been drafted yet (about 1,000 tokens in, 700 out, 500 thinking). */
const TYPICAL_DRAFT_USD = (1000 * 1.5 + 1200 * 7.5) / 1_000_000

/**
 * "What drafts cost": the receipt for the last draft (what was sent, what was written, the thinking, the total), then the
 * drafts made on this laptop, a monthly planner, and the Demo / Real AI switch for team testing. Everything is a paid-tier
 * figure: on the free tier the real bill is $0. The history holds numbers only and stays in this browser.
 */
export function CostDialog({
  open,
  onClose,
  last,
  realAi,
  onRealAiChange,
  version,
}: {
  open: boolean
  onClose: () => void
  /** The latest draft's usage, and whether it was a demo draft (nothing sent). */
  last: { usage: UsageEvent; demo: boolean } | null
  realAi: boolean
  onRealAiChange: (on: boolean) => void
  /** Changes when a draft is added, so the history is read again. */
  version: number
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [perDay, setPerDay] = useState(10)
  const [cleared, setCleared] = useState(0)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Read again each time it opens, when a draft is added, or after "Clear history".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarizeHistory(loadHistory()), [open, version, cleared])
  const lines = last ? receiptLines(last.usage) : []
  const perDraft = summary.average ?? (last && !last.demo ? last.usage.costUsd : null) ?? TYPICAL_DRAFT_USD
  const basis = summary.average !== null ? 'your average' : last && !last.demo && last.usage.costUsd !== null ? 'your last draft' : 'a typical draft'
  const top = Math.max(...summary.recent, 0.0001)

  return (
    <dialog
      ref={ref}
      className="cost-dialog"
      aria-labelledby="cost-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="cost-body">
        <div className="cost-head">
          <h3 id="cost-title">What drafts cost</h3>
          <button type="button" className="phone-close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {last ? (
          <section className="receipt" aria-labelledby="receipt-title">
            <h4 id="receipt-title">{last.demo ? 'Example: a draft of this size' : 'This draft'}</h4>
            <dl className="receipt-lines">
              {lines.map((line) => (
                <div key={line.label} className="receipt-line">
                  <dt>
                    {line.label} <span className="receipt-tokens">{formatTokens(line.tokens)} tokens</span>
                  </dt>
                  <dd>{formatUsd(line.amount)}</dd>
                </div>
              ))}
              <div className="receipt-line is-total">
                <dt>{last.demo ? 'Would cost' : 'Total'}</dt>
                <dd>{formatUsd(last.usage.costUsd)}</dd>
              </div>
            </dl>
            <p className="receipt-note">
              {last.demo
                ? 'This was a demo draft: nothing was sent, so nothing was spent. The figures estimate what a real draft would use.'
                : `On the free tier you paid $0.00. These are paid-tier prices, checked ${PRICE_VERSION}.${last.usage.estimated ? ' Token counts are estimated from the text length.' : ''}`}
            </p>
          </section>
        ) : (
          <p className="cost-empty">Write a draft and its receipt appears here: what was sent, what was written, and what it would cost on a paid plan.</p>
        )}

        <section className="cost-section" aria-labelledby="cost-history-title">
          <h4 id="cost-history-title">On this laptop</h4>
          {summary.drafts > 0 ? (
            <>
              <p className="cost-figures">
                <strong>{summary.drafts}</strong> {summary.drafts === 1 ? 'draft' : 'drafts'} · <strong>{formatUsd(summary.average)}</strong> average ·{' '}
                <strong>{formatUsd(summary.total)}</strong> total
              </p>
              <div className="cost-bars" role="img" aria-label={`Cost of your last ${summary.recent.length} drafts`}>
                {summary.recent.map((amount, i) => (
                  <span key={i} style={{ height: `${Math.max(8, (amount / top) * 100)}%` }} />
                ))}
              </div>
            </>
          ) : (
            <p className="cost-empty">
              {summary.demoDrafts > 0
                ? `${summary.demoDrafts} demo ${summary.demoDrafts === 1 ? 'draft' : 'drafts'} so far. They cost nothing and aren’t counted.`
                : 'No drafts yet.'}
            </p>
          )}
        </section>

        <section className="cost-section" aria-labelledby="cost-plan-title">
          <h4 id="cost-plan-title">Plan ahead</h4>
          <label className="cost-plan">
            <input
              type="number"
              min={0}
              max={500}
              value={perDay}
              onChange={(event) => setPerDay(Math.min(500, Math.max(0, Math.floor(Number(event.target.value) || 0))))}
              aria-label="Drafts a day"
            />
            <span>drafts a day, about</span>
            <strong>{formatUsd(monthlyCost(perDraft, perDay))}</strong>
            <span>a month</span>
          </label>
          <p className="cost-small">At {formatUsd(perDraft)} a draft ({basis}), 22 working days. Google may charge less: the free tier costs nothing, and its paid price for this model is lower until 2026-12-31.</p>
        </section>

        <section className="cost-section" aria-labelledby="cost-test-title">
          <h4 id="cost-test-title">Testing</h4>
          <div className="phone-switch" role="group" aria-label="Drafting mode">
            <button type="button" aria-pressed={!realAi} onClick={() => onRealAiChange(false)}>
              Demo drafting
            </button>
            <button type="button" aria-pressed={realAi} onClick={() => onRealAiChange(true)}>
              Real AI drafting
            </button>
          </div>
          <p className="cost-small">
            {realAi
              ? 'Real AI sends the placeholder text (never the photo or the real details) to Gemini after you approve. The free tier is shared by everyone using Cloak, so it can answer “too many requests”.'
              : 'Demo writes a placeholder draft and sends nothing. Switch to Real AI to test the cloud model.'}
          </p>
        </section>

        <div className="cost-foot">
          <button
            type="button"
            className="mini-btn"
            onClick={() => {
              clearHistory()
              setCleared((n) => n + 1)
            }}
            disabled={summary.drafts + summary.demoDrafts === 0}
          >
            Clear history
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
