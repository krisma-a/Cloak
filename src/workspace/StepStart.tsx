interface StepStartProps {
  onPaste: () => void
  onScan: () => void
}

/** The first screen: what kind of material do you have? */
export function StepStart({ onPaste, onScan }: StepStartProps) {
  return (
    <section className="start" aria-labelledby="start-title">
      <div className="start-inner">
        <h2 id="start-title">What do you have?</h2>
        <p className="start-lead">
          Cloak hides names and private details on this laptop. Then AI helps you write, without ever seeing who it’s
          about.
        </p>

        <div className="choices">
          <button type="button" className="choice" onClick={onPaste}>
            <span className="choice-icon is-teal" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3l4 4L8 20l-5 1 1-5L17 3z" />
              </svg>
            </span>
            <span className="choice-title">Paste notes</span>
            <span className="choice-text">Type or paste your case notes.</span>
            <span className="choice-go">Start →</span>
          </button>

          <button type="button" className="choice" onClick={onScan}>
            <span className="choice-icon is-peach" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
              </svg>
            </span>
            <span className="choice-title">Scan a document</span>
            <span className="choice-text">Photo or PDF, like a doctor’s note or a signed form.</span>
            <span className="choice-go">Start →</span>
          </button>
        </div>

        <p className="start-note">Nothing is saved. Everything clears when you close this tab.</p>
      </div>
    </section>
  )
}
