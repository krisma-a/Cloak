import { TEMPLATES } from '../ai/templates.ts'
import type { CheckMode } from './checkMode.ts'
import { WhereChip } from './icons.tsx'
import { SAMPLE_NOTE } from './sampleNote.ts'
import type { TemplateId } from './types.ts'

const CASE_TYPES: { id: TemplateId; label: string }[] = [
  { id: 'investigation', label: 'Investigation' },
  { id: 'accommodation', label: 'Accommodation' },
  { id: 'termination', label: 'Termination' },
]

interface StepPasteProps {
  notes: string
  onNotesChange: (value: string) => void
  templateId: TemplateId
  onTemplateChange: (value: TemplateId) => void
  onContinue: () => void
  onBack: () => void
  error: string | null
  /** Full Cloak or basic checks. Null when this browser can't run the private AI (basic is then the only way). */
  checkMode: CheckMode | null
  onCheckModeChange: (mode: CheckMode) => void
}

const CHECK_MODES: { id: CheckMode; label: string; detail: string }[] = [
  {
    id: 'full',
    label: 'Full Cloak',
    detail: 'The private AI on this laptop finds names, health details and more. The first time, it downloads once (about 4 GB).',
  },
  {
    id: 'basic',
    label: 'Basic checks only',
    detail: 'Faster on slower laptops. Uses simple pattern checks and a small name finder instead of the private AI.',
  },
]

/** How the notes are checked. Full Cloak is the default and the recommendation; basic checks come with a warning. */
function CheckModeChoice({ mode, onChange }: { mode: CheckMode; onChange: (mode: CheckMode) => void }) {
  return (
    <fieldset className="check-mode">
      <legend>How should Cloak check your notes?</legend>
      <div className="check-mode-options">
        {CHECK_MODES.map(({ id, label, detail }) => (
          <label key={id} className={`check-mode-option${id === 'basic' ? ' is-basic' : ''}`}>
            <input type="radio" name="check-mode" value={id} checked={mode === id} onChange={() => onChange(id)} />
            <span className="check-mode-text">
              <span className="check-mode-title">
                {label}
                {id === 'full' && <span className="recommended">Recommended</span>}
              </span>
              <span className="check-mode-detail">{detail}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'basic' && (
        <div className="notice warn check-mode-warning" role="note">
          <p>
            <strong>Riskier: basic checks catch fewer private details.</strong> They can miss unusual names, health
            details and anything written in an unexpected way, so more can reach the cloud if you don’t spot it.
          </p>
          <p>You’ll need to read every line on the next screen. Full Cloak is recommended whenever this laptop can run it.</p>
          <button type="button" className="link-button" onClick={() => onChange('full')}>
            Switch to Full Cloak
          </button>
        </div>
      )}
    </fieldset>
  )
}

export function StepPaste({
  notes,
  onNotesChange,
  templateId,
  onTemplateChange,
  onContinue,
  onBack,
  error,
  checkMode,
  onCheckModeChange,
}: StepPasteProps) {
  return (
    <section className="card">
      <h2>Paste your case notes</h2>
      <p className="muted">
        Names and private details are hidden on this laptop first. Nothing goes to the cloud until you choose to
        write the draft.
      </p>

      <fieldset className="pills">
        <legend>What kind of case is this?</legend>
        <div className="pill-row">
          {CASE_TYPES.map(({ id, label }) => (
            <label key={id} className="pill">
              <input
                type="radio"
                name="case-type"
                value={id}
                checked={templateId === id}
                onChange={() => onTemplateChange(id)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <p className="hint">You’ll get: {TEMPLATES[templateId].label}</p>
      </fieldset>

      <div className="field-head">
        <label className="field-label" htmlFor="case-notes">
          Case notes
        </label>
        <WhereChip where="laptop">Stays on this laptop</WhereChip>
      </div>
      {/* spellCheck is off on purpose: Chrome's "enhanced spell check" can send typed text to Google. */}
      <textarea
        id="case-notes"
        className="notes-input"
        value={notes}
        onChange={(event) => onNotesChange(event.target.value)}
        placeholder="Paste or type your notes here…"
        rows={12}
        spellCheck={false}
        autoComplete="off"
      />

      {notes.trim() === '' && (
        <button type="button" className="link-button" onClick={() => onNotesChange(SAMPLE_NOTE)}>
          Try a sample case
        </button>
      )}

      {checkMode !== null && <CheckModeChoice mode={checkMode} onChange={onCheckModeChange} />}

      {error && (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onContinue} disabled={notes.trim() === ''}>
          Hide private details
        </button>
      </div>
    </section>
  )
}
