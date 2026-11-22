import { useEffect, useRef, useState } from 'react'
import type { DraftResult } from './types.ts'

const STEP_NAMES: Record<string, string> = {
  redaction: 'Hiding private details',
  'cross-check': 'Double-checking names',
  names: 'Checking names',
  restrictions: 'Work restrictions',
  drafting: 'Writing the draft',
  restore: 'Putting real names back',
}

const PLACES: Record<string, string> = {
  on_device: 'on this laptop',
  in_browser: 'in this browser, on this laptop',
  rules: 'on this laptop (simple rules)',
  in_cloud: 'in the cloud',
}

interface StepResultProps {
  result: DraftResult
  onStartOver: () => void
}

export function StepResult({ result, onStartOver }: StepResultProps) {
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

  const { receipt } = result

  return (
    <section className="card">
      <h2>Your draft</h2>
      <p className="muted">Real names are back in place. That happened on this laptop. You can edit the draft below.</p>

      {result.warnings.map((warning) => (
        <p key={warning} className="notice warn">
          {warning}
        </p>
      ))}

      <label className="field-label spaced" htmlFor="final-draft">
        Draft
      </label>
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
        <summary>See exactly what was sent</summary>
        <h3>Sent to the cloud (hidden version only)</h3>
        <pre className="sent-box">{receipt.sentText}</pre>
        <h3>Draft as it came back, before names were restored</h3>
        <pre className="sent-box">{result.draftWithPlaceholders}</pre>
        <h3>Where each step ran</h3>
        <ul className="ran-list">
          {receipt.steps.map((step) => (
            <li key={step.step}>
              <strong>{STEP_NAMES[step.step] ?? step.step}:</strong> {PLACES[step.ranOn] ?? step.ranOn}
            </li>
          ))}
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

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onStartOver}>
          Start over
        </button>
        <button type="button" className="btn btn-primary" onClick={copyDraft}>
          {copied === 'done' ? 'Copied ✓' : 'Copy draft'}
        </button>
      </div>
    </section>
  )
}
