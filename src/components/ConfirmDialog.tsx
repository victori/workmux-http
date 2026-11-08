import { useState } from 'react'

export interface ConfirmDialogProps {
  title: string
  targetLabel: string
  warnings: string[]
  /** Reason the action cannot run even with confirmation. */
  blocked?: string
  confirmLabel: string
  requireAck?: boolean
  busy?: boolean
  onConfirm: (acceptWarnings: boolean) => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  targetLabel,
  warnings,
  blocked,
  confirmLabel,
  requireAck,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [ack, setAck] = useState(false)
  const needAck = requireAck === true || warnings.length > 0
  const canConfirm = !blocked && !busy && (!needAck || ack)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-err/40 bg-surface p-4 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-err">{title}</h2>
        <p className="mt-2 break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm text-fg">
          {targetLabel}
        </p>
        {warnings.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {warnings.map((w) => (
              <li key={w} className="flex gap-2 text-sm text-warn">
                <span aria-hidden>⚠</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
        {blocked && (
          <p className="mt-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
            Blocked: {blocked}
          </p>
        )}
        {warnings.length > 0 && (
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-err)]"
            />
            I accept these warnings
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(ack)}
            disabled={!canConfirm}
            className="flex items-center gap-2 rounded-lg bg-err px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            {busy && <span aria-hidden className="pulse-dot">●</span>}
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
