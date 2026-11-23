import { useState } from 'react'
import type { ComparePiece, Comparison } from './compare.ts'
import { LockIcon, WhereChip } from './icons.tsx'

// "What you typed" next to "What the cloud saw". Display only: it draws two views of text the app
// already has and sends nothing anywhere. Pointing at (or tabbing to) a detail on one side lights
// up the same detail on the other side.

interface LinkProps {
  active: string | null
  onHover: (id: string | null) => void
  onFocus: (id: string | null) => void
}

function Pieces({
  pieces,
  side,
  active,
  onHover,
  onFocus,
}: LinkProps & { pieces: ComparePiece[]; side: 'typed' | 'sent' | 'back' }) {
  // Keyboard: one tab stop per detail on the typed side (its first appearance), not one per mention and
  // not a second set on the cloud side. Every cloud label has a typed twin, so tabbing through the typed
  // side reaches all of them. Every mention still lights up, and the cloud side reacts to the mouse.
  const seen = new Set<string>()
  return (
    <>
      {pieces.map((piece, index) => {
        if (piece.kind === 'text') return <span key={index}>{piece.text}</span>

        // A detail that was not sent in any form (a manager email) has no match to show.
        const linked = piece.kind === 'kept' || piece.sent
        const first = linked && !seen.has(piece.id)
        seen.add(piece.id)
        const link = linked
          ? {
              tabIndex: first && side === 'typed' ? 0 : undefined,
              onMouseEnter: () => onHover(piece.id),
              onMouseLeave: () => onHover(null),
              onFocus: () => onFocus(piece.id),
              onBlur: () => onFocus(null),
            }
          : {}
        const match = linked && active === piece.id ? ' is-match' : ''

        if (piece.kind === 'kept') {
          return (
            <mark key={index} className={`hl is-kept${match}`} {...link}>
              {piece.text}
              <span className="sr-only"> (kept visible, sent as written)</span>
            </mark>
          )
        }

        const name = piece.label.toLowerCase()
        if (side === 'typed') {
          return (
            <mark key={index} className={`hl${match}`} {...link}>
              {piece.text}
              <span className="sr-only"> ({piece.sent ? `hidden: ${name}` : 'not sent'})</span>
            </mark>
          )
        }
        return (
          <span key={index} className={`tag${match}`} {...link}>
            <span aria-hidden="true">{piece.label}</span>
            <span className="sr-only">hidden: {name}</span>
          </span>
        )
      })}
    </>
  )
}

export function CompareSent({ comparison }: { comparison: Comparison }) {
  const [hover, setHover] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const link = { active: hover ?? focus, onHover: setHover, onFocus: setFocus }
  const hasMatches = comparison.typed.some((p) => p.kind === 'kept' || (p.kind === 'hidden' && p.sent))
  const hasInstructions = comparison.instructions.before !== '' || comparison.instructions.after !== ''

  return (
    <div className="compare-wrap">
      <div className="compare">
        <section className="panel is-typed" aria-labelledby="compare-typed">
          <div className="panel-head">
            <h3 id="compare-typed" className="panel-title">
              What you typed
            </h3>
            <WhereChip where="laptop">Stayed on this laptop</WhereChip>
          </div>
          <p className="panel-text">
            <Pieces pieces={comparison.typed} side="typed" {...link} />
          </p>
        </section>

        <div className="seam">
          <div className="seam-core">
            <span className="seam-badge" aria-hidden="true">
              <LockIcon size={24} />
            </span>
            <p className="seam-text">
              <span className="only-wide">Only the right side was sent.</span>
              <span className="only-narrow">Only the box below was sent.</span>
            </p>
          </div>
        </div>

        <section className="panel is-sent" aria-labelledby="compare-sent">
          <div className="panel-head">
            <h3 id="compare-sent" className="panel-title">
              What the cloud saw
            </h3>
            <WhereChip where="cloud">Sent to the cloud</WhereChip>
          </div>
          <p className="panel-text">
            <Pieces pieces={comparison.sent} side="sent" {...link} />
          </p>
          {(comparison.restrictionsOnly || hasInstructions) && (
            <div className="panel-foot">
              {comparison.restrictionsOnly && (
                <p>None of your notes were sent. Only this label and the restrictions you approved.</p>
              )}
              {/* The standard instructions are the rest of the prompt, so the exact text that was sent is all here. */}
              {hasInstructions && (
                <details className="instructions">
                  <summary>Our standard writing instructions went with it</summary>
                  <pre className="sent-box" tabIndex={0} role="region" aria-label="Our standard writing instructions">
                    {comparison.instructions.before}(the text above goes here){comparison.instructions.after}
                  </pre>
                </details>
              )}
            </div>
          )}
        </section>

        {/* The return trip: what the cloud wrote, still with labels. Names go back in on this laptop, which is the draft above. */}
        <section className="panel is-back" aria-labelledby="compare-back">
          <div className="panel-head">
            <h3 id="compare-back" className="panel-title">
              What the cloud wrote back
            </h3>
            <WhereChip where="cloud">Came back from the cloud</WhereChip>
          </div>
          <p className="panel-text">
            <Pieces pieces={comparison.back} side="back" {...link} />
          </p>
          <p className="panel-foot">
            Names are still hidden here. This laptop then put the real names back. That is the draft at the top.
          </p>
        </section>
      </div>
      {hasMatches && <p className="hint">Point at a highlighted detail, or tab to it, to see its match.</p>}
    </div>
  )
}
