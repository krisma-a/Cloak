import { useEffect, useRef, useState } from 'react'
import { TEMPLATES } from './ai/templates.ts'
import { DEMO_MODE, privateAiSupported, redactNotes, SendBlockedError, suggestRestrictions, writeDraft } from './workspace/ai.ts'
import {
  downloadLabel,
  INITIAL_AI_STATE,
  nextAiState,
  pillHelp,
  PILL_TEXT,
  SKIP_HINT,
  SKIP_LABEL,
} from './workspace/aiStatus.ts'
import type { AiEvent, AiState } from './workspace/aiStatus.ts'
import { loadCheckMode, saveCheckMode, type CheckMode } from './workspace/checkMode.ts'
import { LoadingCard, Stepper } from './workspace/components.tsx'
import type { StepInfo } from './workspace/components.tsx'
import { hasWorkToLose, makeLabeler, outgoing } from './workspace/review.ts'
import { StepGenerate } from './workspace/StepGenerate.tsx'
import { StepPaste } from './workspace/StepPaste.tsx'
import { StepResult } from './workspace/StepResult.tsx'
import { StepReview } from './workspace/StepReview.tsx'
import { StepScan } from './workspace/StepScan.tsx'
import { StepStart } from './workspace/StepStart.tsx'
import type { DraftResult, RedactionResult, StepId, TemplateId } from './workspace/types.ts'
import './workspace/workspace.css'
import logo from './assets/logo.png'

const STEPS: StepInfo[] = [
  { id: 'paste', label: 'Paste notes' },
  { id: 'review', label: 'Check details' },
  { id: 'generate', label: 'Write draft' },
  { id: 'result', label: 'Your draft' },
]

type Busy = 'hiding' | 'writing' | null

// Chrome shows its own wording in the leave dialog and ignores this text. It is set anyway for browsers that use it.
const LEAVE_MESSAGE = 'Leave? Your notes and the real names will be cleared.'

export default function App() {
  const [step, setStep] = useState<StepId>('start')
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const lastPercent = useRef(-1)

  // What the header pill and the "Hiding details" card say about the AI on this laptop (see aiStatus.ts).
  const [ai, setAi] = useState<AiState>(INITIAL_AI_STATE)
  const reportAi = (event: AiEvent) => setAi((state) => nextAiState(state, event))
  const skipRef = useRef<AbortController | null>(null) // "Use basic checks for now" aborts this

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
  // Full Cloak (recommended) or basic checks for a slow laptop, remembered in this browser only.
  const [checkMode, setCheckMode] = useState<CheckMode>(() => loadCheckMode())
  // Whether this browser could run the private AI at all. False: basic checks are the only option, so no choice is shown.
  const [nanoPossible, setNanoPossible] = useState<boolean | null>(null)

  function chooseCheckMode(mode: CheckMode) {
    setCheckMode(mode)
    saveCheckMode(mode)
  }

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

  // Everything above is lost when the tab closes. Warn only while there is something to lose; the
  // handler is removed again on the start screen, with empty notes, and after "Start over".
  const workToLose = hasWorkToLose({ notes, base, draft: draftResult })
  useEffect(() => {
    if (!workToLose) return
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = LEAVE_MESSAGE
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [workToLose])

  // Without downloading anything, find out if this browser can run the private AI (Gemini Nano). If it can't,
  // the pill says "Basic checks" from the start. If it can, it says nothing until we know more.
  useEffect(() => {
    let cancelled = false
    privateAiSupported()
      .then((supported) => {
        if (!cancelled) setNanoPossible(supported)
        if (!cancelled && !supported) setAi((state) => nextAiState(state, { type: 'stage', stage: 'basic' }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Runs from the "Hide private details" click, which is what lets Chrome start the one-time model download.
  async function hidePrivateDetails() {
    setBusy('hiding')
    setPasteError(null)
    setProgress(null)
    lastPercent.current = -1
    const skip = new AbortController()
    skipRef.current = skip
    try {
      const result = await redactNotes(
        notes,
        (fraction) => {
          const percent = Math.round(fraction * 100)
          if (percent !== lastPercent.current) {
            lastPercent.current = percent
            setProgress(fraction)
            reportAi({ type: 'progress', fraction })
          }
        },
        {
          onStage: (stage) => reportAi({ type: 'stage', stage }),
          onEngine: (engine) => reportAi({ type: 'engine', engine }),
          skipDownload: skip.signal,
          onBackgroundDone: (engine) => reportAi({ type: 'background-done', engine }),
          basicOnly: checkMode === 'basic' && nanoPossible !== false,
        },
      )
      reportAi({ type: 'engine', engine: result.engine }) // the engine that really ran, in case Nano failed on the way
      setBase(result)
      setKept([])
      setEmployee('')
      setRestrictionsText('')
      setSuggestNote(null)
      setStep('review')
    } catch {
      reportAi({ type: 'failed' })
      setPasteError('Something went wrong on this laptop. Your notes are still here. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  // The one-time download can take a while. This stops the wait: the notes are checked with the basic engine
  // now, and the private AI keeps downloading for next time.
  function skipDownload() {
    setProgress(null)
    lastPercent.current = -1
    reportAi({ type: 'skip' })
    skipRef.current?.abort()
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
            <img src={logo} alt="cloak-logo" className="brand-logo" />
            Cloak
            {onStartScreens ? null : <span className="brand-sub">Case workspace</span>}
          </h1>
          {/* Always in the page, so a change of mode is announced. Shows the real mode of the AI that checks notes. */}
          <span className="ai-slot" role="status">
            {!onStartScreens && ai.mode !== null && (
              <span
                className={`ai-pill is-${ai.mode}${ai.mode === 'basic' && ai.background ? ' is-background' : ''}`}
                title={`${pillHelp(ai)}${DEMO_MODE ? ' Drafts are still placeholders in this build, and nothing is sent anywhere.' : ''}`}
              >
                {PILL_TEXT[ai.mode]}
              </span>
            )}
          </span>
        </header>

        {!onStartScreens && <Stepper steps={STEPS} current={step} onGo={goTo} locked={busy !== null} />}

        <main ref={mainRef} tabIndex={-1}>
          {busy === 'hiding' && (
            <LoadingCard
              title="Hiding details on this laptop…"
              note="Your notes aren’t leaving this computer."
              checks={['Reading your notes', 'Finding names and private details', 'Swapping in labels']}
              where="laptop"
              progress={progress}
              progressLabel={downloadLabel(ai.stage)}
              skip={ai.mode === 'downloading' ? { label: SKIP_LABEL, hint: SKIP_HINT, onClick: skipDownload } : undefined}
            />
          )}
          {busy === 'writing' && (
            <LoadingCard
              title="Writing your draft in the cloud…"
              note="Only the hidden version is being sent."
              checks={['Sending the hidden version', 'Waiting for the draft', 'Putting real names back on this laptop']}
              where="cloud"
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
              checkMode={nanoPossible === false ? null : checkMode}
              onCheckModeChange={chooseCheckMode}
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

          {busy === null && step === 'result' && draftResult && base && (
            <StepResult
              result={draftResult}
              notes={notes}
              base={base}
              kept={kept}
              templateId={templateId}
              onBack={() => goTo('generate')}
              onStartOver={startOver}
            />
          )}
        </main>
      </div>
    </div>
  )
}
