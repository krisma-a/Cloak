import { accommodationBlockReason } from '../ai/restrictionPrompt.ts'
import { TEMPLATES } from '../ai/templates.ts'
import { buildSegments } from './review.ts'
import type { RedactionResult, TemplateId } from './types.ts'

interface StepGenerateProps {
  /** Exactly what would be sent: kept details written in, hidden ones still placeholders. */
  result: RedactionResult
  label: (placeholder: string) => string
  templateId: TemplateId
  keptCount: number
  employee: string
  onEmployeeChange: (value: string) => void
  restrictionsText: string
  onRestrictionsChange: (value: string) => void
  onSuggest: () => void
  suggesting: boolean
  suggestNote: string | null
  confirmed: boolean
  onConfirmedChange: (value: boolean) => void
  /** Set when the guard refused to send. The message says why. */
  blockedMessage: string | null
  error: string | null
  onBack: () => void
  onWrite: () => void
}

export function StepGenerate({
  result,
  label,
  templateId,
  keptCount,
  employee,
  onEmployeeChange,
  restrictionsText,
  onRestrictionsChange,
  onSuggest,
  suggesting,
  suggestNote,
  confirmed,
  onConfirmedChange,
  blockedMessage,
  error,
  onBack,
  onWrite,
}: StepGenerateProps) {
  const template = TEMPLATES[templateId]
  const sendsRestrictions = template.input === 'restrictions'
  const restrictions = restrictionsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const employees = Object.entries(result.map.originals).filter(([placeholder]) => placeholder.startsWith('[EMPLOYEE_'))
  const planProblem = sendsRestrictions
    ? accommodationBlockReason({ employee, restrictions }, result.map, result.redactedText)
    : null
  const needsConfirm = result.needsCarefulReview
  const canWrite = planProblem === null && (!needsConfirm || confirmed)

  return (
    <section className="card">
      <h2>Write the draft</h2>
      <p className="muted">
        Review exactly what will be sent to the cloud. Real names and details stay on this laptop. You’ll get:{' '}
        <strong>{template.label}</strong>.
      </p>

      {sendsRestrictions ? (
        <>
          <p className="notice info">
            A manager email sends only the work restrictions below. No case notes and no health details leave this
            laptop.
          </p>

          <label className="field-label spaced" htmlFor="employee">
            Who is this for?
          </label>
          <select
            id="employee"
            className="select-input wide"
            value={employee}
            onChange={(event) => onEmployeeChange(event.target.value)}
          >
            <option value="">Choose…</option>
            {employees.map(([placeholder]) => (
              <option key={placeholder} value={placeholder}>
                {label(placeholder)}
              </option>
            ))}
          </select>

          <label className="field-label spaced" htmlFor="restrictions">
            Work restrictions (one per line)
          </label>
          <textarea
            id="restrictions"
            className="notes-input"
            rows={4}
            value={restrictionsText}
            onChange={(event) => onRestrictionsChange(event.target.value)}
            placeholder="For example: a short break every 2 hours"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="row">
            <button type="button" className="btn btn-quiet" onClick={onSuggest} disabled={suggesting}>
              {suggesting ? 'Looking…' : 'Suggest from the notes'}
            </button>
            {suggestNote && <span className="hint">{suggestNote}</span>}
          </div>
          {planProblem && <p className="hint">{planProblem}</p>}
        </>
      ) : (
        <div className="notes-view" tabIndex={0} role="region" aria-label="Text that will be sent to the cloud">
          {buildSegments(result, []).map((segment, index) =>
            segment.kind === 'text' ? (
              <span key={index}>{segment.text}</span>
            ) : (
              <span key={index} className="label static">
                {label(segment.placeholder)}
              </span>
            ),
          )}
        </div>
      )}

      {!sendsRestrictions && keptCount > 0 && (
        <p className="notice warn">
          You chose to keep {keptCount} {keptCount === 1 ? 'detail' : 'details'} visible. They will be sent exactly as
          written.
        </p>
      )}

      {needsConfirm && (
        <div className="notice warn">
          <p>Your laptop used simpler checks, so please read what will be sent before you continue.</p>
          <label className="check-row">
            <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} />
            <span>I’ve read it, and nothing private is left.</span>
          </label>
        </div>
      )}

      {blockedMessage && (
        <div className="notice warn" role="alert">
          <p>
            <strong>We stopped it before sending.</strong> {blockedMessage}
          </p>
          <button type="button" className="btn btn-quiet" onClick={onBack}>
            Go back and check
          </button>
        </div>
      )}

      {error && (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onWrite} disabled={!canWrite}>
          Write the draft
        </button>
      </div>
    </section>
  )
}
