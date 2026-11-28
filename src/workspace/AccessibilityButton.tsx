import { useCallback, useEffect, useRef, useState } from 'react'
import { isDefaultA11y, SPEED_MAX, SPEED_MIN, stepTextSize, DEFAULT_A11Y } from './a11y.ts'
import type { A11ySettings } from './a11y.ts'
import { IDLE_MINUTES } from './controls.ts'
import { AccessIcon, SpeakerIcon, StopIcon } from './icons.tsx'
import { chunkForSpeech, pickLocalVoice } from './speech.ts'

interface AccessibilityButtonProps {
  settings: A11ySettings
  onChange: (next: A11ySettings) => void
  /** The part of the page "Read this screen" reads. */
  getReadRoot: () => HTMLElement | null
  /** Changes when the screen changes, so reading stops instead of carrying on over a different screen. */
  readKey: string
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CANVAS', 'VIDEO', 'IMG', 'INPUT'])
const BLOCK_TAGS = new Set([
  'ARTICLE', 'BUTTON', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'H1', 'H2', 'H3', 'H4', 'LABEL', 'LEGEND',
  'LI', 'OL', 'P', 'SECTION', 'SELECT', 'SUMMARY', 'TEXTAREA', 'TR', 'UL',
])

/** Visible text of a screen, in reading order. Text boxes are read too (the page shows their text, innerText doesn't). */
function readableText(root: HTMLElement): string {
  const out: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? '')
      return
    }
    if (!(node instanceof HTMLElement)) return // SVG icons and comments
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('data-no-read')) return
    if (SKIP_TAGS.has(node.tagName)) return
    const block = BLOCK_TAGS.has(node.tagName)
    if (block) out.push('\n')
    if (node instanceof HTMLTextAreaElement) {
      out.push(node.value)
    } else if (node instanceof HTMLSelectElement) {
      out.push(node.selectedOptions[0]?.text ?? '')
    } else if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = node.querySelector(':scope > summary')
      if (summary) walk(summary)
    } else {
      node.childNodes.forEach(walk)
    }
    if (block) out.push('\n')
  }
  walk(root)
  return out.join('').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

/** What the person had selected (in the page or in a text box) before the panel opened. */
function selectedText(): string {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === 'text')) {
    const start = active.selectionStart ?? 0
    const end = active.selectionEnd ?? 0
    if (end > start) return active.value.slice(start, end)
  }
  return window.getSelection()?.toString() ?? ''
}

/**
 * The round accessibility button (bottom right) and its panel: read aloud, bigger text, high contrast,
 * roomy spacing, less motion, and more time before the privacy auto-clear. Settings are preferences only.
 * Reading aloud uses only voices that run on this laptop, because the screens can show real names.
 */
export function AccessibilityButton({ settings, onChange, getReadRoot, readKey }: AccessibilityButtonProps) {
  const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [speaking, setSpeaking] = useState(false)
  const [selection, setSelection] = useState('')
  const runId = useRef(0)

  useEffect(() => {
    if (!synth) return
    const load = () => setVoices(synth.getVoices())
    load()
    synth.addEventListener('voiceschanged', load)
    return () => synth.removeEventListener('voiceschanged', load)
  }, [synth])

  const voice = pickLocalVoice(voices, document.documentElement.lang || navigator.language || 'en-US')

  const stop = useCallback(() => {
    runId.current += 1
    synth?.cancel()
    setSpeaking(false)
  }, [synth])

  // Reading stops when the screen changes and when the page goes away.
  useEffect(() => stop, [readKey, stop])
  useEffect(() => {
    window.addEventListener('pagehide', stop)
    return () => window.removeEventListener('pagehide', stop)
  }, [stop])

  function speak(text: string) {
    if (!synth || !voice) return
    const pieces = chunkForSpeech(text)
    if (pieces.length === 0) return
    runId.current += 1
    const mine = runId.current
    synth.cancel()
    pieces.forEach((piece, index) => {
      const utterance = new SpeechSynthesisUtterance(piece)
      utterance.voice = voice
      utterance.lang = voice.lang
      utterance.rate = settings.speed
      const finish = () => {
        if (runId.current === mine && index === pieces.length - 1) setSpeaking(false)
      }
      utterance.onend = finish
      utterance.onerror = () => {
        if (runId.current === mine) setSpeaking(false)
      }
      synth.speak(utterance)
    })
    setSpeaking(true)
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function openPanel() {
    setSelection(selectedText().trim())
    setOpen(true)
  }

  function readScreen() {
    const root = getReadRoot()
    if (root) speak(readableText(root))
  }

  const set = <K extends keyof A11ySettings>(key: K, value: A11ySettings[K]) => onChange({ ...settings, [key]: value })
  const canSpeak = voice !== null

  return (
    <>
      <div className="a11y-dock" data-no-read>
        {speaking && (
          <button type="button" className="a11y-stop-pill" onClick={stop}>
            <StopIcon size={16} />
            Stop reading
          </button>
        )}
        <button
          type="button"
          className={`a11y-fab${speaking ? ' is-speaking' : ''}`}
          onClick={openPanel}
          aria-label="Accessibility options"
          aria-haspopup="dialog"
          title="Accessibility options"
        >
          <span className="a11y-fab-icon" aria-hidden="true">
            <AccessIcon size={30} />
          </span>
          <span className="a11y-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        </button>
      </div>

      <dialog
        ref={dialogRef}
        className="cost-dialog a11y-dialog"
        aria-labelledby="a11y-title"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}
      >
        {open && (
          <div className="cost-body">
            <div className="cost-head">
              <h3 id="a11y-title">Accessibility</h3>
              <button type="button" className="phone-close" onClick={() => setOpen(false)} aria-label="Close">
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <section className="a11y-section" aria-labelledby="a11y-read">
              <h4 id="a11y-read">Read aloud</h4>
              <div className="a11y-row">
                <button type="button" className="btn btn-primary a11y-btn" onClick={readScreen} disabled={!canSpeak}>
                  <SpeakerIcon size={18} />
                  Read this screen
                </button>
                <button
                  type="button"
                  className="btn btn-quiet a11y-btn"
                  onClick={() => speak(selection)}
                  disabled={!canSpeak || selection === ''}
                >
                  Read my selection
                </button>
                <button type="button" className="btn btn-quiet a11y-btn" onClick={stop} disabled={!speaking}>
                  <StopIcon size={16} />
                  Stop
                </button>
              </div>
              <label className="a11y-range" htmlFor="a11y-speed">
                <span>Speed</span>
                <input
                  id="a11y-speed"
                  type="range"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={0.1}
                  value={settings.speed}
                  onChange={(event) => set('speed', Math.round(Number(event.target.value) * 10) / 10)}
                />
                <output aria-live="polite">{settings.speed.toFixed(1)}×</output>
              </label>
              <p className="hint">
                {canSpeak
                  ? 'Spoken by a voice on this laptop. The text is never sent anywhere.'
                  : synth
                    ? 'This browser has no voice that runs on this laptop, so reading aloud is off. Cloak won’t use a voice that sends text to a server.'
                    : 'This browser can’t read aloud. Your computer’s screen reader will still work with every screen.'}
              </p>
            </section>

            <section className="a11y-section" aria-labelledby="a11y-see">
              <h4 id="a11y-see">Make it easier to see</h4>
              <div className="a11y-size">
                <span id="a11y-size-label">Text size</span>
                <div className="a11y-stepper" role="group" aria-labelledby="a11y-size-label">
                  <button
                    type="button"
                    className="a11y-step"
                    onClick={() => set('textSize', stepTextSize(settings.textSize, -1))}
                    disabled={settings.textSize === 100}
                    aria-label="Smaller text"
                  >
                    <span aria-hidden="true">A−</span>
                  </button>
                  <output className="a11y-size-value" aria-live="polite">
                    {settings.textSize}%
                  </output>
                  <button
                    type="button"
                    className="a11y-step is-big"
                    onClick={() => set('textSize', stepTextSize(settings.textSize, 1))}
                    disabled={settings.textSize === 150}
                    aria-label="Larger text"
                  >
                    <span aria-hidden="true">A+</span>
                  </button>
                </div>
              </div>
              <Switch
                label="High contrast"
                detail="Darker text and stronger outlines."
                checked={settings.highContrast}
                onChange={(on) => set('highContrast', on)}
              />
              <Switch
                label="Roomy spacing"
                detail="More space between letters, words and lines."
                checked={settings.roomySpacing}
                onChange={(on) => set('roomySpacing', on)}
              />
              <Switch
                label="Reduce motion"
                detail="Stops spinners, fades and other movement."
                checked={settings.reduceMotion}
                onChange={(on) => set('reduceMotion', on)}
              />
            </section>

            <section className="a11y-section" aria-labelledby="a11y-time">
              <h4 id="a11y-time">More time</h4>
              <fieldset className="pills a11y-time">
                <legend>For privacy, Cloak clears your work after no activity for</legend>
                <div className="pill-row">
                  {IDLE_MINUTES.map((minutes) => (
                    <label key={minutes} className="pill">
                      <input
                        type="radio"
                        name="a11y-idle"
                        checked={settings.idleMinutes === minutes}
                        onChange={() => set('idleMinutes', minutes)}
                      />
                      <span>{minutes} minutes</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="hint">You always get a one-minute warning first, and one click keeps your work.</p>
            </section>

            <div className="cost-foot">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  stop()
                  onChange(DEFAULT_A11Y)
                }}
                disabled={isDefaultA11y(settings)}
              >
                Reset to defaults
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        )}
      </dialog>
    </>
  )
}

function Switch({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="a11y-switch">
      <span className="a11y-switch-text">
        <span className="a11y-switch-label">{label}</span>
        <span className="a11y-switch-detail">{detail}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="a11y-track" aria-hidden="true" />
    </label>
  )
}
