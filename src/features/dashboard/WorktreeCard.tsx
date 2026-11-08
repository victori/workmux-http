import { useEffect, useRef, useState } from 'react'
import type { ActionType, OperationView, PreparedAction, WorktreeView } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { StatusDots } from '../../components/StatusBadge'
import { truncateMiddle } from './agentSort'

/** Server binds the token to action+target+state; it rides on the prepare response. */
type PreparedWithToken = PreparedAction & { confirmToken?: string }

const TITLES: Record<'open' | 'close' | 'remove', string> = {
  open: 'Open worktree',
  close: 'Close worktree',
  remove: 'Remove worktree',
}

export function worktreeLabel(w: WorktreeView): string {
  return `${w.project}/${w.handle}`
}

async function pollOperation(id: string, cancelled: () => boolean): Promise<OperationView | null> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    if (cancelled()) return null
    try {
      const op = await api.operation(id)
      if (op.state === 'done' || op.state === 'failed' || op.state === 'unknown') return op
    } catch {
      return null
    }
  }
}

export function WorktreeCard({
  worktree,
  hotkey,
  selected,
  onOpenDiff,
}: {
  worktree: WorktreeView
  hotkey?: number
  selected: boolean
  onOpenDiff: (id: string, label: string) => void
}) {
  const [pending, setPending] = useState<{ action: 'open' | 'close' | 'remove'; prepared: PreparedWithToken } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  async function startAction(action: 'open' | 'close' | 'remove'): Promise<void> {
    setNote(null)
    try {
      const prepared = (await api.prepare({ action, targetId: worktree.id })) as PreparedWithToken
      setPending({ action, prepared })
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'could not prepare action')
    }
  }

  async function confirm(acceptWarnings: boolean): Promise<void> {
    const token = pending?.prepared.confirmToken
    if (!pending || !token) return
    setBusy(true)
    try {
      const op = await api.execute({
        action: pending.action,
        targetId: worktree.id,
        acceptWarnings,
        confirmToken: token,
        requestId: crypto.randomUUID(),
      })
      const final = await pollOperation(op.id, () => cancelledRef.current)
      if (final) {
        setNote(final.state === 'done' ? '✓ done' : final.error ?? `operation ${final.state}`)
      }
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'action failed')
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  return (
    <div className={`rounded-xl border bg-surface p-3 ${selected ? 'border-accent ring-2 ring-accent/40' : 'border-line'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg">
          {hotkey !== undefined && (
            <span aria-hidden className="shrink-0 rounded border border-line px-1 text-[10px] leading-4 text-fg-muted">
              {hotkey}
            </span>
          )}
          <span className="truncate font-mono">{worktree.branch}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {worktree.isMain && (
            <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-fg-muted">main</span>
          )}
          {(worktree.unpushed ?? 0) > 0 && (
            <span
              title={`${worktree.unpushed} unpushed commit${worktree.unpushed === 1 ? '' : 's'}`}
              className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium tabular-nums text-accent"
            >
              ↑{worktree.unpushed}
            </span>
          )}
          {worktree.hasUncommittedChanges && (
            <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn">dirty</span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              worktree.isOpen ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-fg-muted'
            }`}
          >
            {worktree.isOpen ? 'open' : 'closed'}
          </span>
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p title={worktree.path} className="min-w-0 truncate font-mono text-xs text-fg-muted">
          {truncateMiddle(worktree.path)}
        </p>
        <StatusDots statuses={worktree.agentStatuses} />
      </div>
      {worktree.prUrl && (
        <a
          href={worktree.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs text-accent"
        >
          PR ↗
        </a>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <button
          onClick={() => onOpenDiff(worktree.id, worktreeLabel(worktree))}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-muted"
        >
          Diff
        </button>
        <button
          onClick={() => void startAction(worktree.isOpen ? 'close' : 'open')}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-muted"
        >
          {worktree.isOpen ? 'Close' : 'Open'}
        </button>
        <button
          onClick={() => void startAction('remove')}
          className="rounded-lg border border-err/40 px-3 py-1.5 text-xs font-medium text-err"
        >
          Remove
        </button>
        {note && <span className="ml-auto text-xs text-fg-muted">{note}</span>}
      </div>

      {pending && (
        <ConfirmDialog
          title={TITLES[pending.action]}
          targetLabel={pending.prepared.targetLabel}
          warnings={pending.prepared.warnings}
          blocked={pending.prepared.blocked}
          confirmLabel={pending.action === 'remove' ? 'Remove' : pending.action === 'close' ? 'Close' : 'Open'}
          requireAck={pending.prepared.warnings.length > 0}
          busy={busy}
          onConfirm={(accept) => void confirm(accept)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
