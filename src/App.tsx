import { useEffect, useRef, useState } from 'react'
import { buildDraftPrompt, buildManagerPrompt, TEMPLATES } from './ai/templates.ts'
import type { UsageEvent } from './ai/usage.ts'
import { applyAiParam, privateAiSupported, realAiEnabled, redactNotes, SendBlockedError, setRealAi, suggestRestrictions, writeDraft } from './workspace/ai.ts'
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
import { AboutPage } from './workspace/AboutPage.tsx'
import { AccessibilityButton } from './workspace/AccessibilityButton.tsx'
import { a11yAttributes, loadA11y, saveA11y } from './workspace/a11y.ts'
import type { A11ySettings } from './workspace/a11y.ts'
import { ConfirmDialog } from './workspace/ConfirmDialog.tsx'
import { idleStatus, previousStep, writeSummary } from './workspace/controls.ts'
import type { IdleState } from './workspace/controls.ts'
import { LoadingCard, Stepper } from './workspace/components.tsx'
import { ArrowLeftIcon, TrashIcon, WhereChip } from './workspace/icons.tsx'
import type { StepInfo } from './workspace/components.tsx'
import { hasWorkToLose, makeLabeler, outgoing } from './workspace/review.ts'
import { StepGenerate } from './workspace/StepGenerate.tsx'
import { StepPaste } from './workspace/StepPaste.tsx'
import { StepResult } from './workspace/StepResult.tsx'
import { StepReview } from './workspace/StepReview.tsx'
import { StepScan } from './workspace/StepScan.tsx'
import { StepStart } from './workspace/StepStart.tsx'
import { ModeDialog } from './workspace/ModeDialog.tsx'
import { UsageDialog } from './workspace/UsageDialog.tsx'
import { draftErrorMessage } from './workspace/draftError.ts'
import { addDraftRecord, estimateDraftCost, formatUsd } from './workspace/draftCost.ts'
import { track } from './analytics.ts'
import { blockReasonCode } from './analyticsEvents.ts'
import { checkLanguage, NOT_ENGLISH_NOTICE } from './workspace/language.ts'
import { getLanguageDetector } from './workspace/languageDetector.ts'
import { SpecsNotice } from './workspace/SpecsNotice.tsx'
import { markSpecsSeen, shouldShowSpecs, specsSeen } from './workspace/specs.ts'
import type { DeviceInfo } from './workspace/specs.ts'
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
  // True when this note didn't look like English, so it was checked with the basic engine (see workspace/language.ts).
  const [notEnglish, setNotEnglish] = useState(false)
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)
  // Full Cloak (recommended) or basic checks for a slow laptop, remembered in this browser only.
  const [checkMode, setCheckMode] = useState<CheckMode>(() => loadCheckMode())
  // Whether this browser could run the private AI at all. False: basic checks are the only option, so no choice is shown.
  const [nanoPossible, setNanoPossible] = useState<boolean | null>(null)
  // Drafting mode (Demo or Real AI) and the usage of the last draft; see workspace/ai.ts, ModeDialog and UsageDialog.
  const [realAi, setRealAiState] = useState(() => {
    applyAiParam()
    return realAiEnabled()
  })
  // Accessibility settings (the round button), the About page, and the pop-ups for writing, clearing and going back.
  const [a11y, setA11y] = useState<A11ySettings>(() => loadA11y())
  const [aboutOpen, setAboutOpen] = useState(false)
  const [writeOpen, setWriteOpen] = useState(false)
  const [clearAllOpen, setClearAllOpen] = useState(false)
  const [backOpen, setBackOpen] = useState(false)
  const [autoCleared, setAutoCleared] = useState<number | null>(null) // minutes, when the privacy timer cleared the work
  function changeA11y(next: A11ySettings) {
    setA11y(next)
    saveA11y(next)
  }
  const [usageOpen, setUsageOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [lastCost, setLastCost] = useState<{ usage: UsageEvent; demo: boolean } | null>(null)
  const [costVersion, setCostVersion] = useState(0)
  function chooseRealAi(on: boolean) {
    setRealAi(on)
    setRealAiState(on)
  }

  // The one-time "Cloak runs best on…" notice for slower or unsupported setups, once we know what this device can do.
  const [specsDismissed, setSpecsDismissed] = useState(() => specsSeen())
  const device = deviceInfo(nanoPossible)
  const specsOpen = !specsDismissed && shouldShowSpecs(device)

  function closeSpecs() {
    markSpecsSeen()
    setSpecsDismissed(true)
  }

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
  }, [step, busy, aboutOpen])

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

  // Privacy timer: with no activity for a while, warn for a minute, then clear everything (like an automatic
  // log-off). Waiting on the laptop or the cloud counts as activity. "Keep working" resets the clock.
  const lastActive = useRef(0)
  const [idle, setIdle] = useState<IdleState>({ status: 'active', secondsLeft: 0 })
  const idleRef = useRef<IdleState['status']>('active')
  const busyRef = useRef(busy)
  const startOverRef = useRef<() => void>(() => undefined)
  const armed = step !== 'start' || workToLose
  useEffect(() => {
    busyRef.current = busy
    startOverRef.current = startOver
  })
  useEffect(() => {
    idleRef.current = 'active'
    if (!armed) return
    lastActive.current = Date.now()
    const touch = () => {
      if (idleRef.current === 'active') lastActive.current = Date.now()
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
    for (const name of events) window.addEventListener(name, touch, { capture: true, passive: true })
    const timer = setInterval(() => {
      if (busyRef.current) lastActive.current = Date.now()
      const next = idleStatus(Date.now(), lastActive.current, a11y.idleMinutes)
      idleRef.current = next.status === 'expired' ? 'active' : next.status
      if (next.status === 'expired') {
        startOverRef.current()
        setAutoCleared(a11y.idleMinutes)
        setIdle({ status: 'active', secondsLeft: 0 })
        return
      }
      const shown = next.status === 'warning' ? next : { status: 'active' as const, secondsLeft: 0 }
      setIdle((now) => (now.status === shown.status && now.secondsLeft === shown.secondsLeft ? now : shown))
    }, 1000)
    return () => {
      for (const name of events) window.removeEventListener(name, touch, { capture: true })
      clearInterval(timer)
    }
  }, [armed, a11y.idleMinutes])

  function keepWorking() {
    lastActive.current = Date.now()
    idleRef.current = 'active'
    setIdle({ status: 'active', secondsLeft: 0 })
  }

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
  async function hidePrivateDetails(text = notes) {
    setBusy('hiding')
    setPasteError(null)
    setProgress(null)
    lastPercent.current = -1
    const skip = new AbortController()
    skipRef.current = skip
    try {
      // On this device, with Chrome's built-in detector if it is there. No detector or too little text: nothing changes.
      const language = await checkLanguage(text, await getLanguageDetector())
      const useBasic = language?.notEnglish === true
      setNotEnglish(useBasic)
      if (useBasic && language) track('language_fallback', { lang: language.lang })
      const result = await redactNotes(
        text,
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
          basicOnly: useBasic || (checkMode === 'basic' && nanoPossible !== false),
        },
      )
      reportAi({ type: 'engine', engine: result.engine }) // the engine that really ran, in case Nano failed on the way
      track('redact_done', { engine: result.engine, details_hidden: Object.keys(result.map.originals).length })
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
      if (realAi) track('draft_done', { template: templateId, model: result.usage?.model }) // real drafts only: a demo draft sends nothing
      if (result.usage) {
        // The cost is kept on this laptop (numbers only), so the Usage pop-up can show the history.
        const demo = !realAi
        addDraftRecord({ ...result.usage, at: Date.now(), demo })
        setLastCost({ usage: result.usage, demo })
        setCostVersion((n) => n + 1)
      }
      setStep('result')
    } catch (error) {
      if (error instanceof SendBlockedError) {
        setBlockedMessage(error.message)
        track('send_blocked', { reason: blockReasonCode(error.message) }) // a fixed word; the message itself is never logged
      } else {
        // 429 (the shared free allowance), a busy service, no connection, or anything else: each says what to do next.
        setWriteError(draftErrorMessage(error, navigator.onLine))
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
    setAboutOpen(false)
    setAutoCleared(null)
    setStep(target)
  }

  // The Back button in the header: one screen back, or out of the About page.
  function goBack() {
    if (busy) return
    if (aboutOpen) {
      setAboutOpen(false)
      return
    }
    const target = previousStep(step)
    if (!target) return
    // Going back from the draft drops it, so ask first.
    if (step === 'result' && draftResult) setBackOpen(true)
    else goTo(target)
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
    setAboutOpen(false)
    setNotEnglish(false)
    idleRef.current = 'active'
    setIdle({ status: 'active', secondsLeft: 0 })
    setStep('start')
  }

  const result = base ? outgoing(base, kept) : null
  // About what the draft will cost: the length of the prompt that would be sent (placeholders only).
  const estimate = result ? estimateDraftCost(promptLength(result.redactedText, templateId, employee, restrictionsText)) : null
  const onStartScreens = step === 'start' || step === 'scan'
  const canGoBack = aboutOpen || previousStep(step) !== null
  const hasAnything = step !== 'start' || notes.trim() !== ''
  const writeFacts = result
    ? {
        hidden: Object.keys(result.map.originals).length,
        kept: kept.length,
        characters: result.redactedText.length,
        restrictionsOnly: TEMPLATES[templateId].input === 'restrictions',
        realAi,
      }
    : null
  const summary = writeFacts ? writeSummary(writeFacts) : null

  return (
    <div className="cloak-app" {...a11yAttributes(a11y)}>
      <div className="shell">
        <header className="top">
          {canGoBack && (
            <button type="button" className="back-btn" onClick={goBack} disabled={busy !== null}>
              <ArrowLeftIcon size={18} />
              Back
              <span className="sr-only">{aboutOpen ? ' to your work' : ' one step'}</span>
            </button>
          )}
          <h1 className="brand">
            <img src={logo} alt="cloak-logo" className="brand-logo" />
            Cloak
            {onStartScreens ? null : <span className="brand-sub">Case workspace</span>}
          </h1>
          <button
            type="button"
            className={`mode-chip${realAi ? ' is-real' : ''}`}
            onClick={() => setModeOpen(true)}
            aria-haspopup="dialog"
            title="Switch between demo and real AI drafting"
          >
            <span className="mode-full">{realAi ? 'Real AI drafting' : 'Demo drafting'}</span>
            <span className="mode-short" aria-hidden="true">
              {realAi ? 'Real AI' : 'Demo'}
            </span>
          </button>
          <button type="button" className="top-link" onClick={() => setUsageOpen(true)} aria-haspopup="dialog">
            Usage
          </button>
          <button
            type="button"
            className="top-link"
            onClick={() => setAboutOpen(true)}
            aria-current={aboutOpen ? 'page' : undefined}
            disabled={busy !== null}
          >
            About
          </button>
          {hasAnything && (
            <button
              type="button"
              className="top-clear"
              onClick={() => setClearAllOpen(true)}
              disabled={busy !== null}
              title="Clear all"
            >
              <TrashIcon size={16} />
              <span className="top-clear-text">Clear all</span>
            </button>
          )}
          <span className="top-break" aria-hidden="true" />
          {/* Always in the page, so a change of mode is announced. Shows the real mode of the AI that checks notes. */}
          <span className="ai-slot" role="status">
            {!onStartScreens && ai.mode !== null && (
              <span
                className={`ai-pill is-${ai.mode}${ai.mode === 'basic' && ai.background ? ' is-background' : ''}`}
                title={`${pillHelp(ai)}${realAi ? '' : ' Drafting is in demo mode: placeholders only, and nothing is sent anywhere.'}`}
              >
                {PILL_TEXT[ai.mode]}
              </span>
            )}
          </span>
        </header>

        {!onStartScreens && !aboutOpen && <Stepper steps={STEPS} current={step} onGo={goTo} locked={busy !== null} />}

        <main ref={mainRef} tabIndex={-1}>
          {autoCleared !== null && step === 'start' && !aboutOpen && busy === null && (
            <p className="notice info auto-cleared" role="status">
              For your privacy, Cloak cleared your work after {autoCleared} minutes with no activity.
              <button type="button" className="link-btn" onClick={() => setAutoCleared(null)}>
                Dismiss
              </button>
            </p>
          )}
          {busy === null && aboutOpen && <AboutPage onBack={() => setAboutOpen(false)} />}
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

          {busy === null && !aboutOpen && step === 'start' && (
            <StepStart
              onPaste={() => goTo('paste')}
              onScan={() => goTo('scan')}
            />
          )}

          {busy === null && !aboutOpen && step === 'scan' && (
            <StepScan
              onBack={() => goTo('start')}
              onScanDone={(pages, fixed) => track('scan_done', { pages, rechecked_fixed: fixed })}
              basicChecks={checkMode === 'basic' || nanoPossible === false}
              onDraft={(text) => {
                // The scanned text becomes the notes (in memory only) and goes through the same steps as pasted
                // notes: hidden on this laptop, checked on the review screen, and only then sent. This runs from the
                // pop-up's click, which Chrome needs to start the private AI download.
                setNotes(text)
                void hidePrivateDetails(text)
              }}
            />
          )}

          {busy === null && !aboutOpen && step === 'paste' && (
            <StepPaste
              notes={notes}
              onNotesChange={setNotes}
              templateId={templateId}
              onTemplateChange={setTemplateId}
              onContinue={() => void hidePrivateDetails()}
              onBack={() => goTo('start')}
              error={pasteError}
              checkMode={nanoPossible === false ? null : checkMode}
              onCheckModeChange={chooseCheckMode}
            />
          )}

          {busy === null && !aboutOpen && step === 'review' && base && notEnglish && (
            <p className="notice warn lang-notice" role="status">
              {NOT_ENGLISH_NOTICE}
            </p>
          )}
          {busy === null && !aboutOpen && step === 'review' && base && (
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

          {busy === null && !aboutOpen && step === 'generate' && base && result && (
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
              onWrite={() => setWriteOpen(true)}
              estimate={estimate}
              realAi={realAi}
              onRealAiChange={chooseRealAi}
              onShowCost={() => setUsageOpen(true)}
            />
          )}

          {busy === null && !aboutOpen && step === 'result' && draftResult && base && (
            <StepResult
              result={draftResult}
              notes={notes}
              base={base}
              kept={kept}
              templateId={templateId}
              onBack={() => goTo('generate')}
              onStartOver={startOver}
              cost={lastCost}
              onShowCost={() => setUsageOpen(true)}
            />
          )}
        </main>
      </div>
      <UsageDialog open={usageOpen} onClose={() => setUsageOpen(false)} last={lastCost} version={costVersion} />
      <ModeDialog open={modeOpen} onClose={() => setModeOpen(false)} realAi={realAi} onRealAiChange={chooseRealAi} />
      <ConfirmDialog
        open={writeOpen && summary !== null}
        title={realAi ? 'Write the draft?' : 'Write the demo draft?'}
        confirmLabel={realAi ? 'Yes, write the draft' : 'Write the demo draft'}
        cancelLabel="Not yet"
        onConfirm={() => {
          setWriteOpen(false)
          void writeTheDraft()
        }}
        onCancel={() => setWriteOpen(false)}
      >
        {summary && (
          <div className="send-summary">
            <div className="send-group">
              <WhereChip where={realAi ? 'cloud' : 'laptop'}>{realAi ? 'Goes to the cloud' : 'Nothing is sent'}</WhereChip>
              <ul>
                {summary.sent.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div className="send-group">
              <WhereChip where="laptop">Stays on this laptop</WhereChip>
              <ul>
                {summary.stays.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            {estimate && (
              <p className="hint">
                {realAi ? 'About ' : 'A real draft would cost about '}
                {formatUsd(estimate.costUsd)} on a paid plan ($0.00 on the free tier).
                {realAi && ' Once it’s sent, it can’t be taken back.'}
              </p>
            )}
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={clearAllOpen}
        title="Clear everything?"
        confirmLabel="Clear everything"
        tone="danger"
        onConfirm={() => {
          setClearAllOpen(false)
          startOver()
        }}
        onCancel={() => setClearAllOpen(false)}
      >
        <p>
          This removes your notes, the hidden labels and any draft from this tab. Cloak keeps nothing, so it can’t be
          undone.
        </p>
        {draftResult && <p className="hint">Save your draft first if you want to keep it.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={backOpen}
        title="Go back and clear this draft?"
        confirmLabel="Go back"
        cancelLabel="Stay here"
        tone="danger"
        onConfirm={() => {
          setBackOpen(false)
          goTo('generate')
        }}
        onCancel={() => setBackOpen(false)}
      >
        <p>
          The draft is based on the details you checked, so going back clears it. Use “Save draft” first if you want
          to keep it.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={armed && idle.status === 'warning'}
        title="Still there?"
        confirmLabel="Clear now"
        cancelLabel="Keep working"
        tone="danger"
        onConfirm={() => {
          keepWorking()
          startOver()
          setAutoCleared(null)
        }}
        onCancel={keepWorking}
      >
        <p>
          For your privacy, Cloak clears your notes and draft in <strong>{idle.secondsLeft} seconds</strong> because
          there has been no activity.
        </p>
      </ConfirmDialog>
      <AccessibilityButton
        settings={a11y}
        onChange={changeA11y}
        getReadRoot={() => mainRef.current}
        readKey={`${step}:${aboutOpen}`}
      />
      <SpecsNotice
        open={specsOpen}
        device={device}
        onClose={closeSpecs}
        onUseBasic={
          nanoPossible
            ? () => {
                chooseCheckMode('basic')
                closeSpecs()
              }
            : undefined
        }
      />
    </div>
  )
}

/** What the browser says about this device, for the specs notice. Read each render; nothing is stored or sent. */
function deviceInfo(privateAi: boolean | null): DeviceInfo {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }>; platform?: string; mobile?: boolean }
    deviceMemory?: number
  }
  return {
    brands: nav.userAgentData?.brands,
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform,
    mobile: nav.userAgentData?.mobile,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    cores: nav.hardwareConcurrency || undefined,
    memoryGb: nav.deviceMemory,
    privateAi,
  }
}

/** The length of the prompt that would go to the cloud, for the cost estimate. */
function promptLength(redactedText: string, templateId: TemplateId, employee: string, restrictionsText: string): number {
  if (TEMPLATES[templateId].input === 'restrictions') {
    return buildManagerPrompt(employee, restrictionsText.split('\n').map((line) => line.trim()).filter(Boolean)).length
  }
  return buildDraftPrompt(redactedText, templateId).length
}
