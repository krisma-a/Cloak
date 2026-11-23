import { ScanIcon } from './icons.tsx'

interface StepScanProps {
  onBack: () => void
  onPaste: () => void
}

/** Placeholder. Scanning a document is not built yet, so this points to what works today. */
export function StepScan({ onBack, onPaste }: StepScanProps) {
  return (
    <section className="card empty">
      <span className="choice-icon is-peach" aria-hidden="true">
        <ScanIcon size={28} />
      </span>
      <h2>Scanning isn’t ready yet</h2>
      <p className="muted">Paste your notes instead. Cloak hides the private details in them the same way.</p>
      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onPaste}>
          Paste notes instead
        </button>
      </div>
    </section>
  )
}
