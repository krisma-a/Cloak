import { useEffect, useMemo, useRef, useState } from 'react'
import { TEMPLATES } from '../ai/templates.ts'
import type { UsageEvent } from '../ai/usage.ts'
import { formatUsd } from './draftCost.ts'
import { downloadBlob, downloadTextFile } from '../download.ts'
import { buildComparison } from './compare.ts'
import { CompareSent } from './CompareSent.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { saveFileName } from './controls.ts'
import type { SaveFormat } from './controls.ts'
import { DownloadIcon, TrashIcon, WhereChip } from './icons.tsx'
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
  const [saveOpen, setSaveOpen] = useState(false)
  const [format, setFormat] = useState<SaveFormat>('pdf')
  const [clearOpen, setClearOpen] = useState(false)
  const [saved, setSaved] = useState<SaveFormat | null>(null)
  const draftBox = useRef<HTMLTextAreaElement>(null)
  const edited = text !== result.restoredDraft

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

  // Saving makes a file on this laptop from the text in the box (including any edits), straight into the
  // Downloads folder. Cloak keeps no copy and nothing is sent anywhere. The file name has no names in it.
  function saveDraft() {
    const name = saveFileName(templateId, format, new Date())
    if (format === 'pdf') {
      const label = TEMPLATES[templateId]?.label
      // No title line when the draft already opens with it.
      const title = label && !text.trim().toLowerCase().startsWith(label.toLowerCase()) ? label : undefined
      downloadBlob(name, new Blob([textToPdf(text, title)], { type: 'application/pdf' }))
    } else {
      downloadTextFile(name, text, 'text/plain')
    }
    setSaved(format)
    setSaveOpen(false)
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
        <div className="field-tools">
          <button
            type="button"
            className="clear-btn"
            onClick={() => {
              setText(result.restoredDraft)
              draftBox.current?.focus()
            }}
            disabled={!edited}
          >
            Reset to original
          </button>
          <button type="button" className="clear-btn" onClick={() => setClearOpen(true)} disabled={text === ''}>
            <TrashIcon size={15} />
            Clear
          </button>
          <WhereChip where="laptop">Real names, on this laptop only</WhereChip>
        </div>
      </div>
      {/* spellCheck is off on purpose: this text has real names, and Chrome's enhanced spell check can send text to Google. */}
      <textarea
        id="final-draft"
        ref={draftBox}
        className="notes-input tall"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setSaved(null)
        }}
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
        {saved ? `Draft saved as a ${saved === 'pdf' ? 'PDF' : 'text'} file in your Downloads folder.` : ''}
      </p>
      {saved && (
        <p className="notice info" role="note">
          Saved to your Downloads folder as {saved === 'pdf' ? 'a PDF' : 'a text file'}. It has real names in it, so keep
          it where your records policy says. Cloak keeps no copy.
        </p>
      )}

      {cost && (
        <p className="cost-line">
          {cost.demo ? 'Demo draft: nothing was sent. A real one would have cost about ' : 'This draft cost about '}
          <strong>{formatUsd(cost.usage.costUsd)}</strong> on a paid plan ($0.00 on the free tier).
          {onShowCost && (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={onShowCost}>
                See usage
              </button>
            </>
          )}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onStartOver}>
          Start over
        </button>
        <button type="button" className="btn btn-outline" onClick={() => setSaveOpen(true)} disabled={text.trim() === ''}>
          <DownloadIcon size={18} />
          Save draft
        </button>
        <button type="button" className="btn btn-primary" onClick={copyDraft} disabled={text.trim() === ''}>
          {copied === 'done' ? 'Copied ✓' : 'Copy draft'}
        </button>
      </div>

      <ConfirmDialog
        open={saveOpen}
        title="Save your draft"
        confirmLabel="Save"
        onConfirm={saveDraft}
        onCancel={() => setSaveOpen(false)}
      >
        <p>The file is made on this laptop and goes to your Downloads folder. Cloak doesn’t keep a copy.</p>
        <fieldset className="pills">
          <legend>File type</legend>
          <div className="pill-row">
            <label className="pill">
              <input type="radio" name="save-format" checked={format === 'pdf'} onChange={() => setFormat('pdf')} />
              <span>PDF</span>
            </label>
            <label className="pill">
              <input type="radio" name="save-format" checked={format === 'txt'} onChange={() => setFormat('txt')} />
              <span>Text file</span>
            </label>
          </div>
        </fieldset>
        <p className="hint">The draft has real names in it, so store the file where your records policy says.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={clearOpen}
        title="Clear the draft?"
        confirmLabel="Clear the draft"
        tone="danger"
        onConfirm={() => {
          setText('')
          setClearOpen(false)
          draftBox.current?.focus()
        }}
        onCancel={() => setClearOpen(false)}
      >
        <p>This empties the box. You can bring the original back with “Reset to original”, until you leave this screen.</p>
      </ConfirmDialog>
    </section>
  )
}
