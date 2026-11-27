import { DraftingMode } from './DraftingMode.tsx'
import { formatUsd } from './draftCost.ts'
import type { DraftCost } from './draftCost.ts'
import { accommodationBlockReason } from '../ai/restrictionPrompt.ts'
import { TEMPLATES } from '../ai/templates.ts'
import { TrashIcon, WhereChip } from './icons.tsx'
import { buildSegments, employeeOptions } from './review.ts'
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
  /** About what this draft will cost, shown next to the button. Null when it can't be worked out yet. */
  estimate?: DraftCost | null
  /** Real AI sends the text to the cloud; Demo doesn't, and says so. */
  realAi?: boolean
  /** Switches between Demo and Real AI drafting (shown here, because this is where the draft is sent). */
  onRealAiChange?: (on: boolean) => void
  onShowCost?: () => void
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
  estimate = null,
  realAi = false,
  onRealAiChange,
  onShowCost,
}: StepGenerateProps) {
  const template = TEMPLATES[templateId]
  const sendsRestrictions = template.input === 'restrictions'
  const restrictions = restrictionsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const employees = employeeOptions(result.map, label)
  const hiddenCount = Object.keys(result.map.originals).length
  const planProblem = sendsRestrictions
    ? accommodationBlockReason({ employee, restrictions }, result.map, result.redactedText)
    : null
  // With no names to pick from, the notice below already explains it, so don't also say "choose which employee".
  const noEmployees = sendsRestrictions && employees.length === 0
  const planHint = planProblem && !(noEmployees && restrictions.length > 0) ? planProblem : null
  const needsConfirm = result.needsCarefulReview
  const canWrite = planProblem === null && (!needsConfirm || confirmed)

  return (
    <section className="card">
      <h2>Write the draft</h2>
      <p className="muted">
        Review exactly what will be sent to the cloud. Real names and details stay on this laptop. You’ll get:{' '}
        <strong>{template.label}</strong>.
      </p>

      {onRealAiChange && <DraftingMode realAi={realAi} onChange={onRealAiChange} />}

      {sendsRestrictions ? (
        <>
          <p className="notice info">
            A manager email sends only the work restrictions below. No case notes and no health details leave this
            laptop.
          </p>

          {noEmployees ? (
            <div className="notice warn">
              <p>
                <strong>There’s no one to write this email about yet.</strong> Cloak needs the employee’s name hidden
                first, so the cloud never sees it. Go back to “Check details” and hide their name. If you chose to
                keep it visible, switch it back to hidden.
              </p>
              <button type="button" className="btn btn-quiet" onClick={onBack}>
                Go back and check
              </button>
            </div>
          ) : (
            <>
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
                {/* The text is for the person reading. The value is the placeholder, and only that is used. */}
                {employees.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.text}
                  </option>
                ))}
              </select>
            </>
          )}

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
            <button
              type="button"
              className="clear-btn"
              onClick={() => onRestrictionsChange('')}
              disabled={restrictionsText === ''}
            >
              <TrashIcon size={15} />
              Clear restrictions
            </button>
            {suggestNote && <span className="hint">{suggestNote}</span>}
          </div>
          {planHint && <p className="hint">{planHint}</p>}
        </>
      ) : (
        <>
          <div className="field-head">
            <span className="field-label" id="outbound-label">
              What the cloud will receive
            </span>
            <WhereChip where="cloud">Goes to the cloud</WhereChip>
          </div>
          <div className="notes-view is-outbound" tabIndex={0} role="region" aria-labelledby="outbound-label">
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
          {hiddenCount > 0 && (
            <p className="hint">
              {hiddenCount} private {hiddenCount === 1 ? 'detail is' : 'details are'} hidden. The cloud sees only the
              labels.
            </p>
          )}
        </>
      )}

      {!sendsRestrictions && keptCount > 0 && (
        <p className="notice warn">
          You chose to keep {keptCount} {keptCount === 1 ? 'detail' : 'details'} visible. They will be sent exactly as
          written.
        </p>
      )}

      {needsConfirm && (
        <div className="notice warn">
          <p>Your laptop used basic checks, so please read what will be sent before you continue.</p>
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

      {estimate && (
        <p className="cost-line">
          {realAi ? 'Estimated cost: ' : 'Demo draft: nothing is sent. A real one would cost about '}
          <strong>{formatUsd(estimate.costUsd)}</strong> on a paid plan ($0.00 on the free tier).
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
