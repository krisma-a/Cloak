import { useEffect, useRef } from 'react'
import { DraftingMode } from './DraftingMode.tsx'

/** A small pop-up for the Demo / Real AI drafting switch, opened from the chip in the header. */
export function ModeDialog({ open, onClose, realAi, onRealAiChange }: { open: boolean; onClose: () => void; realAi: boolean; onRealAiChange: (on: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="cost-dialog mode-dialog"
      aria-labelledby="mode-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="cost-body">
        <div className="cost-head">
          <h3 id="mode-title">Drafting mode</h3>
          <button type="button" className="phone-close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <DraftingMode realAi={realAi} onChange={onRealAiChange} />
        <div className="cost-foot">
          <span />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
