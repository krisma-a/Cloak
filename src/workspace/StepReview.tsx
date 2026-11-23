import { useEffect, useRef, useState } from 'react'
import { confirmNoNames, hideNames, splitNames } from '../ai/guard.ts'
import type { Category } from '../ai/placeholders.ts'
import { WhereChip } from './icons.tsx'
import {
  buildSegments,
  fixLeaks,
  hideText,
  HIDE_CHOICES,
  makeLabeler,
  outgoing,
  reviewItems,
  toggleKept,
} from './review.ts'
import type { RedactionResult } from './types.ts'

interface StepReviewProps {
  base: RedactionResult
  kept: string[]
  onChange: (next: { base: RedactionResult; kept: string[] }) => void
  onBack: () => void
  onContinue: () => void
}

interface Pending {
  text: string
  x: number
  y: number
  below: boolean
}

export function StepReview({ base, kept, onChange, onBack, onContinue }: StepReviewProps) {
  const notesRef = useRef<HTMLDivElement>(null)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [peeking, setPeeking] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [category, setCategory] = useState<Category>('PERSON')
  const [typed, setTyped] = useState('')
  const [namesInput, setNamesInput] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const label = makeLabeler(base.map)
  const segments = buildSegments(base, kept)
  const items = reviewItems(segments)
  const now = outgoing(base, kept)
  const hiddenCount = items.filter((item) => item.hidden).length
  const keptCount = items.length - hiddenCount
  const choiceLabel = HIDE_CHOICES.find((choice) => choice.category === category)?.label ?? 'Other'
  const namesUnchecked = base.names === 'unchecked'
  const canContinue = now.leaks.length === 0 && !namesUnchecked

  // Click a label to peek at what is under it. It hides itself again after a few seconds.
  function peek(placeholder: string) {
    if (peekTimer.current) clearTimeout(peekTimer.current)
    setPeeking(placeholder)
    peekTimer.current = setTimeout(() => setPeeking(null), 3000)
  }

  useEffect(() => {
    return () => {
      if (peekTimer.current) clearTimeout(peekTimer.current)
    }
  }, [])

  // Select words in the notes and a small "Hide" button appears next to them.
  useEffect(() => {
    function onSelectionChange() {
      const selection = window.getSelection()
      const root = notesRef.current
      if (!selection || !root || selection.rangeCount === 0 || selection.isCollapsed) {
        setPending(null)
        return
      }
      const range = selection.getRangeAt(0)
      const start = range.startContainer.parentElement?.closest('[data-text-segment]')
      const end = range.endContainer.parentElement?.closest('[data-text-segment]')
      if (!start || start !== end || !root.contains(start) || range.toString().trim() === '') {
        setPending(null)
        return
      }
      const box = range.getBoundingClientRect()
      const below = box.top < 64
      setPending({ text: range.toString(), x: box.left + box.width / 2, y: below ? box.bottom : box.top, below })
    }

    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', onSelectionChange, true)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', onSelectionChange, true)
    }
  }, [])

  function hide(text: string): boolean {
    const next = hideText(base, text, category)
    if (next === base) {
      setMessage('We couldn’t hide that. Pick whole words that appear in the notes, outside the dark labels.')
      return false
    }
    onChange({ base: next, kept })
    setMessage(null)
    return true
  }

  function hideSelection() {
    if (!pending) return
    hide(pending.text)
    window.getSelection()?.removeAllRanges()
    setPending(null)
  }

  return (
    <section className="card">
      <h2>Check what was hidden</h2>
      <p className="muted">
        Dark labels replaced private details on this laptop. Click a label to peek. Select any other words to hide
        them too.
      </p>

      {base.note && <p className="notice info">{base.note}</p>}
      {base.needsCarefulReview && (
        <p className="notice warn">
          Simpler checks were used on this laptop, so they may miss things. Please read all of the notes carefully.
        </p>
      )}

      {/* What blocks "Looks good, continue" comes first, so it is never buried below the notes. */}
      {namesUnchecked && (
        <div className="notice warn">
          <p>
            <strong>Names haven’t been checked.</strong> This kind of check can’t find names. Type every person’s
            name from the notes, or confirm there are none.
          </p>
          <label className="field-label" htmlFor="names-input">
            Names in this case (separate with commas)
          </label>
          <input
            id="names-input"
            className="text-input"
            type="text"
            value={namesInput}
            onChange={(event) => setNamesInput(event.target.value)}
            placeholder="Maria Santos, Chidi Okafor"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="row">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={splitNames(namesInput).length === 0}
              onClick={() => {
                onChange({ base: hideNames(base, splitNames(namesInput)), kept })
                setNamesInput('')
              }}
            >
              Hide these names
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => onChange({ base: confirmNoNames(base), kept })}>
              There are no names in the text
            </button>
          </div>
        </div>
      )}

      {now.leaks.length > 0 && (
        <div className="notice warn" role="alert">
          <p>
            <strong>Something that looks private is still visible:</strong>{' '}
            {now.leaks.map((leak) => `“${leak.text}”`).join(', ')}
          </p>
          <button type="button" className="btn btn-quiet" onClick={() => onChange(fixLeaks(base, kept))}>
            Hide {now.leaks.length === 1 ? 'it' : 'them'}
          </button>
        </div>
      )}

      <div className="review-grid">
        <div className="review-main">
          <div className="field-head">
            <span className="field-label" id="review-notes-label">
              Your notes, with private details hidden
            </span>
            <WhereChip where="laptop">Checked on this laptop</WhereChip>
          </div>
          <div className="notes-view" ref={notesRef} role="region" aria-labelledby="review-notes-label">
            {segments.map((segment, index) => {
              if (segment.kind === 'text') {
                return (
                  <span key={index} data-text-segment="">
                    {segment.text}
                  </span>
                )
              }
              if (!segment.hidden) {
                return (
                  <button
                    key={index}
                    type="button"
                    className="kept"
                    title="Click to hide this again"
                    onClick={() => onChange({ base, kept: toggleKept(kept, segment.placeholder) })}
                  >
                    {segment.original}
                  </button>
                )
              }
              const showing = peeking === segment.placeholder
              return (
                <button
                  key={index}
                  type="button"
                  className={showing ? 'label is-peek' : 'label'}
                  aria-label={showing ? undefined : `Hidden ${label(segment.placeholder)}. Click to peek.`}
                  onClick={() => peek(segment.placeholder)}
                >
                  {showing ? segment.original : label(segment.placeholder)}
                </button>
              )
            })}
          </div>

          {pending && (
            <button
              type="button"
              className={pending.below ? 'float-hide below' : 'float-hide'}
              style={{ left: pending.x, top: pending.y }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={hideSelection}
            >
              Hide as {choiceLabel}
            </button>
          )}

          <form
            className="hide-more"
            onSubmit={(event) => {
              event.preventDefault()
              if (hide(typed)) setTyped('')
            }}
          >
            <div className="grow">
              <label className="field-label" htmlFor="hide-more-input">
                Hide another word or phrase
              </label>
              <input
                id="hide-more-input"
                className="text-input"
                type="text"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value)
                  setMessage(null)
                }}
                placeholder="Type it exactly as it appears"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="hide-as">
                Hide as
              </label>
              <select
                id="hide-as"
                className="select-input"
                value={category}
                onChange={(event) => setCategory(event.target.value as Category)}
              >
                {HIDE_CHOICES.map((choice) => (
                  <option key={choice.category} value={choice.category}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-quiet" disabled={typed.trim() === ''}>
              Hide it
            </button>
          </form>
          {message && (
            <p className="notice warn" role="alert">
              {message}
            </p>
          )}
        </div>

        <section className="review-side" aria-labelledby="review-hidden-title">
          <h3 id="review-hidden-title" className="side-title">
            Hidden details
          </h3>
          {items.length === 0 ? (
            <p className="notice warn">
              Nothing was hidden. If your notes have names or private details, select them in the notes to hide them.
            </p>
          ) : (
            <>
              <p className="side-count">
                {hiddenCount} hidden on this laptop{keptCount > 0 ? `, ${keptCount} kept visible` : ''}
              </p>
              <ul className="review-list">
                {items.map((item) => (
                  <li key={item.placeholder}>
                    <span>
                      {item.hidden ? (
                        <button
                          type="button"
                          className={peeking === item.placeholder ? 'label is-peek' : 'label'}
                          aria-label={
                            peeking === item.placeholder ? undefined : `Hidden ${label(item.placeholder)}. Click to peek.`
                          }
                          onClick={() => peek(item.placeholder)}
                        >
                          {peeking === item.placeholder ? item.original : label(item.placeholder)}
                        </button>
                      ) : (
                        <span className="kept static">{item.original}</span>
                      )}
                      {item.count > 1 && <span className="count">×{item.count}</span>}
                    </span>
                    <button
                      type="button"
                      className="mini-btn"
                      aria-label={item.hidden ? `Keep ${label(item.placeholder)} visible` : `Hide ${item.original} again`}
                      onClick={() => onChange({ base, kept: toggleKept(kept, item.placeholder) })}
                    >
                      {item.hidden ? 'Keep visible' : 'Hide again'}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <div className="actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onContinue} disabled={!canContinue}>
          Looks good, continue
        </button>
      </div>
    </section>
  )
}
