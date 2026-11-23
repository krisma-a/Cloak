import { TEMPLATES } from '../ai/templates.ts'
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
}

export function StepPaste({ notes, onNotesChange, templateId, onTemplateChange, onContinue, onBack, error }: StepPasteProps) {
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
