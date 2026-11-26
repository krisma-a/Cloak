/**
 * The Demo / Real AI drafting switch: where it matters (the "Write the draft" screen) and at the top of the cost dialog.
 * Demo writes a placeholder draft and sends nothing. Real AI sends the placeholder text, after approval, to Gemini.
 */
export function DraftingMode({ realAi, onChange }: { realAi: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="drafting-mode">
      <div className="drafting-mode-row">
        <span className="drafting-mode-label" id="drafting-mode-label">
          Drafting
        </span>
        <div className="phone-switch" role="group" aria-labelledby="drafting-mode-label">
          <button type="button" aria-pressed={!realAi} onClick={() => onChange(false)}>
            Demo
          </button>
          <button type="button" aria-pressed={realAi} onClick={() => onChange(true)}>
            Real AI
          </button>
        </div>
      </div>
      <p className="cost-small">
        {realAi
          ? 'Real AI sends the placeholder text (never the photo or the real details) to Gemini after you approve. The free tier is shared by everyone using Cloak, so it can answer “too many requests”.'
          : 'Demo writes a placeholder draft and sends nothing. Switch to Real AI to test the cloud model.'}
      </p>
    </div>
  )
}
