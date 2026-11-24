import { Component } from 'react'
import type { ReactNode } from 'react'
import './workspace.css'

// Full-page messages that sit outside the 4-step flow: a page that is still loading, and a page that crashed.
// Without these, either one shows a blank white page and nobody knows what to do.

/** The same frame the app uses, so a full-page message looks like the rest of Cloak. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="cloak-app">
      <div className="shell">
        <main>{children}</main>
      </div>
    </div>
  )
}

/** Shown while a page's code is still arriving (today only /eval loads late). */
export function LoadingPage({ title, note }: { title: string; note: string }) {
  return (
    <Frame>
      <section className="card loading" role="status" aria-live="polite">
        <div className="loading-ring" aria-hidden="true" />
        <h2>{title}</h2>
        <p className="muted">{note}</p>
      </section>
    </Frame>
  )
}

const DEFAULT_CRASH_NOTE = 'Cloak hit a problem and had to stop. Nothing you pasted was saved, so you’ll need to paste it in again.'

interface ErrorBoundaryProps {
  children: ReactNode
  /** What to say under "Something went wrong". The default is written for the case workspace. */
  note?: string
}

/** Catches a crash anywhere below it, so a bug (or a page that failed to load) shows a plain message instead of a blank page. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <Frame>
        <section className="card empty" role="alert">
          <h2>Something went wrong</h2>
          <p className="muted">{this.props.note ?? DEFAULT_CRASH_NOTE}</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </section>
      </Frame>
    )
  }
}
