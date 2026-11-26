import { useEffect, useMemo, useRef, useState } from 'react'
import { TEMPLATES } from '../ai/templates.ts'
import type { UsageEvent } from '../ai/usage.ts'
import { formatUsd } from './draftCost.ts'
import { downloadBlob } from '../download.ts'
import { buildComparison } from './compare.ts'
import { CompareSent } from './CompareSent.tsx'
import { WhereChip } from './icons.tsx'
import { textToPdf } from './textPdf.ts'
import type { DraftResult, RedactionResult, TemplateId } from './types.ts'

const STEP_NAMES: Record<string, string> = {
  redaction: 'Hiding private details',
  'cross-check': 'Double-checking names',
  names: 'Checking names',
  restrictions: 'Work restrictions',
  drafting: 'Writing the draft',
  restore: 'Putting real names back',
}

const PLACES: Record<string, { text: string; where: 'laptop' | 'cloud' }> = {
  on_device: { text: 'On this laptop', where: 'laptop' },
  in_browser: { text: 'In this browser, on this laptop', where: 'laptop' },
  rules: { text: 'On this laptop (simple rules)', where: 'laptop' },
  in_cloud: { text: 'In the cloud', where: 'cloud' },
}

interface StepResultProps {
  result: DraftResult
  /** What the person typed. Only shown on this screen, never sent. */
  notes: string
  /** The redaction with every detail still a placeholder, and the details the person kept visible. */
  base: RedactionResult
  kept: readonly string[]
  templateId: TemplateId
  /** Back to the "Write the draft" screen, for when the cloud sent nothing back. */
  onBack: () => void
  onStartOver: () => void
  /** What this draft used and cost (a demo draft's is an estimate). Opens the cost dialog from the link beside it. */
  cost?: { usage: UsageEvent; demo: boolean } | null
  onShowCost?: () => void
}

export function StepResult({ result, notes, base, kept, templateId, onBack, onStartOver, cost = null, onShowCost }: StepResultProps) {
  const comparison = useMemo(
    () =>
      buildComparison({
        notes,
        base,
        kept,
        sentText: result.receipt.sentText,
        draftWithPlaceholders: result.draftWithPlaceholders,
        templateId,
      }),
    [notes, base, kept, result.receipt.sentText, result.draftWithPlaceholders, templateId],
  )
  const [text, setText] = useState(result.restoredDraft)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied('idle'), 3000)
  }

  // The draft as a PDF, made on this laptop from the text in the box (including any edits). Never sent anywhere.
  function downloadPdf() {
    const label = TEMPLATES[templateId]?.label
    // No title line when the draft already opens with it.
    const title = label && !text.trim().toLowerCase().startsWith(label.toLowerCase()) ? label : undefined
    downloadBlob(`cloak-${templateId}-draft.pdf`, new Blob([textToPdf(text, title)], { type: 'application/pdf' }))
  }

  const { receipt } = result

  // The cloud can send back nothing at all. Say so, instead of showing an empty box with a "Copy draft" button.
  // (Only the draft as it arrived counts: someone who clears the box while editing still sees their own screen.)
  if (result.restoredDraft.trim() === '') {
    return (
      <section className="card empty">
        <h2>The draft came back empty</h2>
        <p className="muted">
          The cloud didn’t write anything this time. Your notes are still on this laptop, so you can go back and try
          again.
        </p>
        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onStartOver}>
            Start over
          </button>
          <button type="button" className="btn btn-primary" onClick={onBack}>
            Go back and try again
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="card">
      <h2>Your draft</h2>
      <p className="muted">Real names are back in place. That happened on this laptop. You can edit the draft below.</p>

      {result.warnings.map((warning) => (
        <p key={warning} className="notice warn">
          {warning}
        </p>
      ))}

      <div className="field-head spaced">
        <label className="field-label" htmlFor="final-draft">
          Draft
        </label>
        <WhereChip where="laptop">Real names, on this laptop only</WhereChip>
      </div>
      {/* spellCheck is off on purpose: this text has real names, and Chrome's enhanced spell check can send text to Google. */}
      <textarea
        id="final-draft"
        className="notes-input tall"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        autoComplete="off"
      />

      <details className="sent">
        <summary>Full details of what was sent</summary>
        <CompareSent comparison={comparison} />
        <h3>Where each step ran</h3>
        <ul className="steps">
          {receipt.steps.map((step) => {
            const place = PLACES[step.ranOn]
            return (
              <li key={step.step}>
                <span>{STEP_NAMES[step.step] ?? step.step}</span>
                {place ? <WhereChip where={place.where}>{place.text}</WhereChip> : <span className="where">{step.ranOn}</span>}
              </li>
            )
          })}
        </ul>
        <p className="hint">Fingerprint of what was sent (SHA-256): {receipt.sha256.slice(0, 16)}…</p>
      </details>

      {copied === 'failed' && (
        <p className="notice warn" role="alert">
          We couldn’t copy it automatically. Select the text and press Ctrl+C (Cmd+C on a Mac).
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {copied === 'done' ? 'Draft copied.' : ''}
      </p>

      {cost && (
        <p className="cost-line">
          {cost.demo ? 'Demo draft: nothing was sent. A real one would have cost about ' : 'This draft cost about '}
          <strong>{formatUsd(cost.usage.costUsd)}</strong> on a paid plan ($0.00 on the free tier).
          {onShowCost && (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={onShowCost}>
                See the receipt
              </button>
            </>
          )}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onStartOver}>
          Start over
        </button>
        <button type="button" className="btn btn-outline" onClick={downloadPdf}>
          Download PDF
        </button>
        <button type="button" className="btn btn-primary" onClick={copyDraft}>
          {copied === 'done' ? 'Copied ✓' : 'Copy draft'}
        </button>
      </div>
    </section>
  )
}
