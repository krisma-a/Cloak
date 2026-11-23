import type { CSSProperties } from 'react'
import { WhereChip } from './icons.tsx'
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
  /** Where this step runs, shown as the same chip used on every screen. */
  where: 'laptop' | 'cloud'
  /** 0..1 while a model downloads (the first time only). Leave out to hide the bar. */
  progress?: number | null
  /** What the download is, shown before the percentage: "Downloading the private AI (first time only)…". */
  progressLabel?: string
}

/** Shown while hiding details (on this laptop) and while writing the draft (in the cloud). */
export function LoadingCard({ title, note, checks, where, progress = null, progressLabel = 'Getting ready…' }: LoadingCardProps) {
  const percent = progress === null ? null : Math.round(progress * 100)
  const downloading = percent !== null && percent > 0 && percent < 100

  return (
    <section className="card loading" role="status" aria-live="polite">
      <WhereChip where={where}>{where === 'cloud' ? 'In the cloud' : 'On this laptop'}</WhereChip>
      <div className="loading-ring" aria-hidden="true" />
      <h2>{title}</h2>
      <p className="muted">{note}</p>
      {downloading && (
        <div className="progress">
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          {/* Seen on screen at every percent, but announced only every 10%, so a screen reader is not read 100 updates. */}
          <span aria-hidden="true">
            {progressLabel} {percent}%
          </span>
          <span className="sr-only">
            {progressLabel} {Math.floor(percent / 10) * 10}%
          </span>
        </div>
      )}
      {/* The ticks are for the work itself, so they wait until the one-time download is over. */}
      {!downloading && (
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
      )}
    </section>
  )
}
