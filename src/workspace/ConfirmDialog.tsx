import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** "danger" is for things that can't be undone: the safe button (cancel) gets the focus. */
  tone?: 'primary' | 'danger'
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * One pop-up for every "are you sure?": writing the draft, clearing everything, going back, saving.
 * Built on <dialog>, so the keyboard stays inside it, Escape closes it and focus returns to the button
 * that opened it. Enter does what the focused button says; nothing is confirmed by a stray click on the backdrop.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="cost-dialog confirm-dialog"
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      onCancel={(event) => {
        // Escape. The parent closes the dialog by setting `open` to false.
        event.preventDefault()
        onCancel()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      {open && (
        <div className="cost-body">
          <div className="cost-head">
            <h3 id="confirm-title">{title}</h3>
          </div>
          <div id="confirm-body" className="confirm-text">
            {children}
          </div>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={onCancel}
              data-initial-focus={tone === 'danger' ? '' : undefined}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
              onClick={onConfirm}
              disabled={confirmDisabled}
              data-initial-focus={tone === 'danger' ? undefined : ''}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}
