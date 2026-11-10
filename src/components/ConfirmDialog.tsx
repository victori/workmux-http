import { useState } from 'react'
import type { RemoteStatus } from '@shared/types'

export interface ConfirmDialogProps {
  title: string
  targetLabel: string
  warnings: string[]
  /** For 'push': commits that would be published, newest first (capped). */
  commits?: Array<{ sha: string; subject: string; body?: string }>
  /** True when the commits list was truncated at the cap. */
  commitsTruncated?: boolean
  /** Reason the action cannot run even with confirmation. */
  blocked?: string
  /** For 'push': configured remotes to choose from. */
  remotes?: RemoteStatus[]
  /** For 'push': the currently resolved/selected remote. */
  remote?: string
  /** True when a configured push command owns the remote (picker locked). */
  remoteLocked?: boolean
  /** Effective -u decision; undefined when a custom command owns the flags. */
  setUpstream?: boolean
  onRemoteChange?: (name: string) => void
  onSetUpstreamChange?: (value: boolean) => void
  confirmLabel: string
  /** Ack checkbox text; defaults to the generic warnings wording. */
  ackLabel?: string
  requireAck?: boolean
  busy?: boolean
  onConfirm: (acceptWarnings: boolean) => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  targetLabel,
  warnings,
  commits,
  commitsTruncated,
  blocked,
  remotes,
  remote,
  remoteLocked,
  setUpstream,
  onRemoteChange,
  onSetUpstreamChange,
  confirmLabel,
  ackLabel,
  requireAck,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [ack, setAck] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
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
        {remotes && remotes.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">Push target</p>
            {remoteLocked ? (
              <p className="mt-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm text-fg">
                {remote}
                <span className="ml-2 font-sans text-xs text-fg-muted">configured command decides</span>
              </p>
            ) : (
              <div role="radiogroup" aria-label="Push target remote" className="mt-1 space-y-1">
                {remotes.map((r) => (
                  <label
                    key={r.name}
                    className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                      r.name === remote ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:bg-surface-2'
                    }`}
                  >
                    <input
                      type="radio"
                      name="push-remote"
                      value={r.name}
                      aria-label={r.name}
                      checked={r.name === remote}
                      onChange={() => onRemoteChange?.(r.name)}
                      className="h-4 w-4"
                    />
                    <span className="font-mono">{r.name}</span>
                    {r.upstream && (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">upstream</span>
                    )}
                    <span className="ml-auto font-mono text-xs tabular-nums text-fg-muted">
                      {r.hasRef ? `↑${r.unpushed ?? '?'}` : 'new'}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {!remoteLocked && setUpstream !== undefined && remote !== undefined && (
              <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-fg-muted">
                <input
                  type="checkbox"
                  checked={setUpstream}
                  onChange={(e) => onSetUpstreamChange?.(e.target.checked)}
                  className="h-4 w-4"
                />
                Set {remote} as upstream
              </label>
            )}
          </div>
        )}
        {commits && commits.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              {commits.length} commit{commits.length === 1 ? '' : 's'} to publish
            </p>
            <ul role="list" className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-surface-2 px-2 py-2">
              {commits.map((c) => {
                const open = expanded.has(c.sha)
                const row = (
                  <>
                    <span className="shrink-0 text-accent">{c.sha}</span>
                    <span className={`min-w-0 ${open ? 'break-words whitespace-normal' : 'truncate'}`} title={c.subject}>
                      {c.subject}
                    </span>
                    {(c.body ?? '') !== '' && (
                      <span aria-hidden className={`ml-auto shrink-0 text-fg-muted ${open ? 'rotate-90' : ''}`}>
                        ▸
                      </span>
                    )}
                  </>
                )
                return (
                  <li key={c.sha} className="text-xs text-fg">
                    {(c.body ?? '') !== '' ? (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(c.sha)) next.delete(c.sha)
                            else next.add(c.sha)
                            return next
                          })
                        }
                        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left font-mono hover:bg-surface"
                      >
                        {row}
                      </button>
                    ) : (
                      <span className="flex items-center gap-2 px-1 py-0.5 font-mono">{row}</span>
                    )}
                    {open && (
                      <pre className="mx-1 mt-1 mb-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface px-2 py-1.5 font-mono text-[11px] leading-snug text-fg-muted">
                        {c.body}
                      </pre>
                    )}
                  </li>
                )
              })}
              {commitsTruncated && (
                <li className="text-[11px] italic text-fg-muted">…older commits not shown</li>
              )}
            </ul>
          </div>
        )}
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
        {needAck && (
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-err)]"
            />
            {ackLabel ?? 'I accept these warnings'}
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
