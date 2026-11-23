import { ChevronIcon, LockIcon, PencilIcon, ScanIcon, WhereChip } from './icons.tsx'

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
              <PencilIcon size={28} />
            </span>
            <span className="choice-title">Paste notes</span>
            <span className="choice-text">Type or paste your case notes.</span>
            <span className="choice-go">
              Start
              <ChevronIcon size={18} />
            </span>
          </button>

          <button type="button" className="choice" onClick={onScan}>
            <span className="choice-icon is-peach" aria-hidden="true">
              <ScanIcon size={28} />
            </span>
            <span className="choice-title">Scan a document</span>
            <span className="choice-text">Photo or PDF, like a doctor’s note or a signed form.</span>
            <span className="choice-go">
              Start
              <ChevronIcon size={18} />
            </span>
          </button>
        </div>

        {/* The whole idea in one sentence, with made-up data: what you type, and what the cloud gets. Closed until asked for. */}
        <details className="how">
          <summary>
            See what stays and what’s sent
            <ChevronIcon size={18} />
          </summary>
          <dl className="specimen" aria-label="An example of what Cloak does">
            <div className="specimen-row">
              <dt>
                <WhereChip where="laptop">Stays on this laptop</WhereChip>
              </dt>
              <dd>
                <mark className="hl">Maria Santos</mark> asked for a schedule change.
              </dd>
            </div>
            <div className="specimen-row">
              <dt>
                <WhereChip where="cloud">Sent to the cloud</WhereChip>
              </dt>
              <dd>
                <span className="tag">
                  <span aria-hidden="true">NAME 1</span>
                  <span className="sr-only">hidden: name 1</span>
                </span>{' '}
                asked for a schedule change.
              </dd>
            </div>
          </dl>
        </details>

        <p className="start-note">
          <LockIcon size={15} />
          Nothing is saved. Everything clears when you close this tab.
        </p>
      </div>
    </section>
  )
}
