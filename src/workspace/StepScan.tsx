interface StepScanProps {
  onBack: () => void
}

/** Placeholder. Scanning a document is not built yet. */
export function StepScan({ onBack }: StepScanProps) {
  return (
    <section className="card">
      <h2>Scan a document</h2>
      <p className="muted">This part isn’t ready yet. For now, you can paste your notes instead.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  )
}
