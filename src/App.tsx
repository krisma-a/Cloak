import { useEffect, useRef, useState } from 'react'
import { TEMPLATES } from './ai/templates.ts'
import { DEMO_MODE, redactNotes, SendBlockedError, suggestRestrictions, writeDraft } from './workspace/ai.ts'
import { LoadingCard, Stepper } from './workspace/components.tsx'
import type { StepInfo } from './workspace/components.tsx'
import { makeLabeler, outgoing } from './workspace/review.ts'
import { StepGenerate } from './workspace/StepGenerate.tsx'
import { StepPaste } from './workspace/StepPaste.tsx'
import { StepResult } from './workspace/StepResult.tsx'
import { StepReview } from './workspace/StepReview.tsx'
import { StepScan } from './workspace/StepScan.tsx'
import { StepStart } from './workspace/StepStart.tsx'
import type { DraftResult, RedactionResult, StepId, TemplateId } from './workspace/types.ts'
import './workspace/workspace.css'

const STEPS: StepInfo[] = [
  { id: 'paste', label: 'Paste notes' },
  { id: 'review', label: 'Check details' },
  { id: 'generate', label: 'Write draft' },
  { id: 'result', label: 'Your draft' },
]

type Busy = 'hiding' | 'writing' | null

export default function App() {
  const [step, setStep] = useState<StepId>('start')
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const lastPercent = useRef(-1)

  // Everything below lives in this tab's memory only. Nothing is saved, logged or sent
  // until "Write the draft".
  const [notes, setNotes] = useState('')
  const [templateId, setTemplateId] = useState<TemplateId>('investigation')
  const [base, setBase] = useState<RedactionResult | null>(null) // every detail still a placeholder
  const [kept, setKept] = useState<string[]>([]) // details the person left visible
  const [employee, setEmployee] = useState('')
  const [restrictionsText, setRestrictionsText] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestNote, setSuggestNote] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [draftResult, setDraftResult] = useState<DraftResult | null>(null)

  const [pasteError, setPasteError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)

  // Move keyboard focus to the new screen so screen readers announce it.
  const mainRef = useRef<HTMLElement>(null)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    mainRef.current?.focus()
  }, [step, busy])

  async function hidePrivateDetails() {
    setBusy('hiding')
    setPasteError(null)
    setProgress(null)
    lastPercent.current = -1
    try {
      const result = await redactNotes(notes, (fraction) => {
        const percent = Math.round(fraction * 100)
        if (percent !== lastPercent.current) {
          lastPercent.current = percent
          setProgress(fraction)
        }
      })
      setBase(result)
      setKept([])
      setEmployee('')
      setRestrictionsText('')
      setSuggestNote(null)
      setStep('review')
    } catch {
      setPasteError('Something went wrong on this laptop. Your notes are still here. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  function continueToGenerate() {
    if (!base) return
    const people = Object.keys(outgoing(base, kept).map.originals).filter((p) => p.startsWith('[EMPLOYEE_'))
    setEmployee(people.length === 1 ? (people[0] ?? '') : '')
    setConfirmed(false)
    setBlockedMessage(null)
    setWriteError(null)
    setStep('generate')
  }

  async function findRestrictions() {
    if (!base) return
    setSuggesting(true)
    setSuggestNote(null)
    try {
      const found = await suggestRestrictions(outgoing(base, kept))
      if (found.items.length > 0) setRestrictionsText(found.items.map((item) => item.text).join('\n'))
      setSuggestNote(
        found.items.length > 0
          ? 'Suggestions added. Please edit them.'
          : (found.note ?? 'No suggestions. Type the restrictions yourself.'),
      )
    } catch {
      setSuggestNote('We couldn’t suggest any. Type the restrictions yourself.')
    } finally {
      setSuggesting(false)
    }
  }

  // "Write the draft" is the only thing that sends anything to the cloud.
  async function writeTheDraft() {
    if (!base) return
    const restrictions = restrictionsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    setBusy('writing')
    setBlockedMessage(null)
    setWriteError(null)
    try {
      const result = await writeDraft(outgoing(base, kept), templateId, {
        approved: true,
        accommodation: TEMPLATES[templateId].input === 'restrictions' ? { employee, restrictions } : undefined,
      })
      setDraftResult(result)
      setStep('result')
    } catch (error) {
      if (error instanceof SendBlockedError) {
        setBlockedMessage(error.message)
      } else {
        setWriteError('We couldn’t write the draft just now. Your notes are safe on this laptop. Please try again.')
      }
    } finally {
      setBusy(null)
    }
  }

  // Going back drops the draft, because the details it was based on may change.
  function goTo(target: StepId) {
    if (busy) return
    setBlockedMessage(null)
    setWriteError(null)
    setDraftResult(null)
    setStep(target)
  }

  function startOver() {
    setNotes('')
    setTemplateId('investigation')
    setBase(null)
    setKept([])
    setEmployee('')
    setRestrictionsText('')
    setSuggestNote(null)
    setConfirmed(false)
    setDraftResult(null)
    setPasteError(null)
    setWriteError(null)
    setBlockedMessage(null)
    setStep('start')
  }

  const result = base ? outgoing(base, kept) : null
  const onStartScreens = step === 'start' || step === 'scan'

  return (
    <div className="cloak-app">
      <div className="shell">
        <header className="top">
          <h1 className="brand">
            <span className="brand-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="11" width="14" height="9" rx="2.5" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </span>
            Cloak
            {onStartScreens ? null : <span className="brand-sub">Case workspace</span>}
          </h1>
          {DEMO_MODE && !onStartScreens && (
            <span className="demo-tag" title="The screens use placeholder AI. Nothing is sent anywhere.">
              Demo mode
            </span>
          )}
        </header>

        {!onStartScreens && <Stepper steps={STEPS} current={step} onGo={goTo} locked={busy !== null} />}

        <main ref={mainRef} tabIndex={-1}>
          {busy === 'hiding' && (
            <LoadingCard
              title="Hiding details on this laptop…"
              note="Your notes aren’t leaving this computer."
              checks={['Reading your notes', 'Finding names and private details', 'Swapping in labels']}
              progress={progress}
            />
          )}
          {busy === 'writing' && (
            <LoadingCard
              title="Writing your draft in the cloud…"
              note="Only the hidden version is being sent."
              checks={['Sending the hidden version', 'Waiting for the draft', 'Putting real names back on this laptop']}
            />
          )}

          {busy === null && step === 'start' && (
            <StepStart
              onPaste={() => goTo('paste')}
              onScan={() => goTo('scan')}
            />
          )}

          {busy === null && step === 'scan' && <StepScan onBack={() => goTo('start')} />}

          {busy === null && step === 'paste' && (
            <StepPaste
              notes={notes}
              onNotesChange={setNotes}
              templateId={templateId}
              onTemplateChange={setTemplateId}
              onContinue={hidePrivateDetails}
              onBack={() => goTo('start')}
              error={pasteError}
            />
          )}

          {busy === null && step === 'review' && base && (
            <StepReview
              base={base}
              kept={kept}
              onChange={(next) => {
                setBase(next.base)
                setKept(next.kept)
              }}
              onBack={() => goTo('paste')}
              onContinue={continueToGenerate}
            />
          )}

          {busy === null && step === 'generate' && base && result && (
            <StepGenerate
              result={result}
              label={makeLabeler(base.map)}
              templateId={templateId}
              keptCount={kept.length}
              employee={employee}
              onEmployeeChange={setEmployee}
              restrictionsText={restrictionsText}
              onRestrictionsChange={setRestrictionsText}
              onSuggest={findRestrictions}
              suggesting={suggesting}
              suggestNote={suggestNote}
              confirmed={confirmed}
              onConfirmedChange={setConfirmed}
              blockedMessage={blockedMessage}
              error={writeError}
              onBack={() => goTo('review')}
              onWrite={writeTheDraft}
            />
          )}

          {busy === null && step === 'result' && draftResult && (
            <StepResult result={draftResult} onStartOver={startOver} />
          )}
        </main>
      </div>
    </div>
  )
}
