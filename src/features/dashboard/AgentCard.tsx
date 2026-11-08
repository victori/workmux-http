import { useEffect, useRef, useState } from 'react'
import type { AgentView, OperationView, PreparedAction } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { StatusBadge } from '../../components/StatusBadge'
import { humanizeElapsed } from './agentSort'

type PreparedWithToken = PreparedAction & { confirmToken?: string }

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

export function AgentCard({
  agent,
  hotkey,
  selected,
  onOpen,
  onOpenTerminal,
}: {
  agent: AgentView
  hotkey?: number
  selected: boolean
  onOpen: (id: string) => void
  onOpenTerminal: (id: string) => void
}) {
  const [pending, setPending] = useState<PreparedWithToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])

  const unpushed = agent.git?.ahead ?? null

  async function startPush(): Promise<void> {
    setNote(null)
    try {
      const prepared = (await api.prepare({ action: 'push', targetId: agent.worktreeId })) as PreparedWithToken
      setPending(prepared)
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'could not prepare push')
    }
  }

  async function confirmPush(acceptWarnings: boolean): Promise<void> {
    const token = pending?.confirmToken
    if (!pending || !token) return
    setPending(null)
    setBusy(true)
    setNote('pushing…')
    try {
      const op = await api.execute({
        action: 'push',
        targetId: agent.worktreeId,
        acceptWarnings,
        confirmToken: token,
        requestId: crypto.randomUUID(),
      })
      const final = await pollOperation(op.id, () => cancelledRef.current)
      setNote(
        final === null
          ? 'push started — result unknown; check the badge after refresh'
          : final.state === 'done'
            ? `✓ pushed${final.output ? `: ${final.output.split('\n').pop() ?? ''}` : ''}`
            : final.error ?? `push ${final.state}`,
      )
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'push failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`rounded-xl border bg-surface transition-colors ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-line'
      }`}
    >
      <button onClick={() => onOpen(agent.id)} className="block w-full rounded-t-xl p-3 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg">
            {hotkey !== undefined && (
              <span aria-hidden className="shrink-0 rounded border border-line px-1 text-[10px] leading-4 text-fg-muted">
                {hotkey}
              </span>
            )}
            <span className="truncate">{agent.name}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {unpushed !== null && unpushed > 0 && (
              <span
                title={`${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}`}
                className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium tabular-nums text-accent"
              >
                ↑{unpushed}
              </span>
            )}
            <StatusBadge status={agent.status} />
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
          <span className="truncate">{agent.project}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{humanizeElapsed(agent.elapsedSecs)}</span>
          {agent.agentKind && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{agent.agentKind}</span>
            </>
          )}
        </div>
        {agent.title && <p className="mt-1.5 line-clamp-2 text-xs text-fg-muted">{agent.title}</p>}
      </button>
      <div className="flex items-center justify-end gap-1 border-t border-line px-2 py-1">
        {note && (
          <span
            role="status"
            aria-live="polite"
            className="mr-auto min-w-0 px-1 text-[11px] leading-snug text-fg-muted line-clamp-2"
          >
            {busy && (
              <span aria-hidden className="pulse-dot mr-1 text-accent">
                ●
              </span>
            )}
            {note}
          </span>
        )}
        {unpushed !== null && unpushed > 0 && (
          <button
            onClick={() => void startPush()}
            disabled={busy}
            aria-label={`Push ${agent.name}`}
            className="rounded-lg px-2 py-1 text-xs font-medium text-accent disabled:opacity-45"
          >
            {busy ? 'Pushing…' : '⇧ Push'}
          </button>
        )}
        <button
          onClick={() => onOpenTerminal(agent.id)}
          aria-label={`Open terminal for ${agent.name}`}
          className="min-h-0 px-2 py-1 text-xs text-fg-muted"
        >
          ⌨ Terminal
        </button>
      </div>
      {pending && (
        <ConfirmDialog
          title="Push commits"
          targetLabel={pending.targetLabel}
          warnings={pending.warnings}
          commits={pending.commits}
          commitsTruncated={pending.commitsTruncated}
          blocked={pending.blocked}
          confirmLabel="Push now"
          ackLabel="I confirm these commits are ready to push"
          requireAck
          busy={busy}
          onConfirm={(ack) => void confirmPush(ack)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
