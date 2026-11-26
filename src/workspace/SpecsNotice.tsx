import { useEffect, useRef } from 'react'
import { specRows, specsTitle } from './specs.ts'
import type { DeviceInfo, SpecMark } from './specs.ts'

const MARK_TEXT: Record<SpecMark, string> = { ok: 'Meets it', short: 'Below', unknown: 'Can’t tell' }

/**
 * The one-time "Cloak runs best on…" pop-up for slower or unsupported devices: a spec sheet of what Cloak needs next
 * to what this device has, and what it means. When the private AI can run but the laptop is slow, it offers the
 * faster basic checks; otherwise there's nothing to choose, so it just closes.
 */
export function SpecsNotice({
  open,
  device,
  onClose,
  onUseBasic,
}: {
  open: boolean
  device: DeviceInfo
  onClose: () => void
  /** Shown only when the private AI can run here (so there's a real choice). */
  onUseBasic?: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const rows = specRows(device)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="specs-dialog"
      aria-labelledby="specs-title"
      aria-describedby="specs-lead"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="specs-body">
        <h3 id="specs-title">{specsTitle(device)}</h3>
        <p id="specs-lead" className="specs-lead">
          Cloak checks private details on this device, so how fast and how thorough it is depends on the device.
        </p>

        <table className="specs-sheet">
          <caption className="sr-only">What Cloak needs, next to what this device has</caption>
          <thead>
            <tr>
              <th scope="col">Part</th>
              <th scope="col">Cloak runs best with</th>
              <th scope="col">This device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className={`is-${row.mark}`}>
                <th scope="row">{row.label}</th>
                <td>{row.needs}</td>
                <td>
                  <span className="specs-mark" aria-hidden="true" />
                  <span className="specs-here">{row.here}</span>
                  <span className="sr-only"> ({MARK_TEXT[row.mark]})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="specs-means">
          {device.privateAi
            ? 'Full Cloak works here but may be slow. Basic checks are faster, but they catch fewer names.'
            : 'Here, notes and photos get basic checks, which catch fewer names. Read each result carefully, or use Chrome on a laptop that meets the list above.'}
        </p>
        <p className="specs-small">The first private AI download is about 4 GB and needs an unmetered connection.</p>

        <div className="specs-actions">
          {onUseBasic && (
            <button type="button" className="btn btn-quiet" onClick={onUseBasic}>
              Use basic checks
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            {onUseBasic ? 'Keep Full Cloak' : 'Got it'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
