import type { CSSProperties } from 'react'
import type { StepId } from './types.ts'

export interface StepInfo {
  id: StepId
  label: string
}

interface StepperProps {
  steps: StepInfo[]
  current: StepId
  onGo: (id: StepId) => void
  /** True while something is running, so nobody jumps away mid-way. */
  locked: boolean
}

/** The progress bar at the top. Finished steps are buttons, so you can go back. */
export function Stepper({ steps, current, onGo, locked }: StepperProps) {
  const currentIndex = steps.findIndex((step) => step.id === current)

  return (
    <nav aria-label="Case progress">
      <ol className="stepper">
        {steps.map((step, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
          const content = (
            <>
              <span className="stepper-dot" aria-hidden="true">
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span className="stepper-label">
                <span className="sr-only">Step {index + 1}: </span>
                {step.label}
                {state === 'done' && <span className="sr-only"> (finished, go back)</span>}
              </span>
            </>
          )

          return (
            <li
              key={step.id}
              className={`stepper-item is-${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              {state === 'done' ? (
                <button type="button" className="stepper-link" onClick={() => onGo(step.id)} disabled={locked}>
                  {content}
                </button>
              ) : (
                <span className="stepper-link">{content}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

interface LoadingCardProps {
  title: string
  note: string
  checks: string[]
  /** 0..1 while the on-laptop AI loads (the first time it downloads). Leave out to hide the bar. */
  progress?: number | null
}

/** Shown while hiding details (on this laptop) and while writing the draft (in the cloud). */
export function LoadingCard({ title, note, checks, progress = null }: LoadingCardProps) {
  const percent = progress === null ? null : Math.round(progress * 100)

  return (
    <section className="card loading" role="status" aria-live="polite">
      <div className="loading-ring" aria-hidden="true" />
      <h2>{title}</h2>
      <p className="muted">{note}</p>
      {percent !== null && percent > 0 && percent < 100 && (
        <div className="progress">
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span>Getting the on-laptop AI ready… {percent}%</span>
        </div>
      )}
      <ul className="loading-checks">
        {checks.map((text, index) => (
          <li key={text} style={{ '--i': index } as CSSProperties}>
            <span className="check-icon" aria-hidden="true">
              <span className="check-spin" />
              <span className="check-tick">✓</span>
            </span>
            {text}
          </li>
        ))}
      </ul>
    </section>
  )
}
