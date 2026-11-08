import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentView, PreparedAction } from '@shared/types'
import type { ConnectionState } from '../../hooks/useDashboard'
import { api, newRequestId } from '../../lib/api'
import { StatusBadge } from '../../components/StatusBadge'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { OutputPane } from './OutputPane'
import { Composer } from './Composer'
import { AgentSwitcher } from './AgentSwitcher'
import { ModeControl } from './ModeControl'
import type { AgentMode } from './ModeControl'

export interface AgentViewPanelProps {
  agent: AgentView | null
  agents: AgentView[]
  recents: string[]
  connection: ConnectionState
  mode: AgentMode
  /** Rendered in place of the reader body when mode === 'terminal'. */
  terminal?: ReactNode
  /** False while Terminal owns the screen: pauses polling, hides subtree. */
  active: boolean
  onSwitch: (id: string) => void
  onPrevious: () => void
  onOpenDiff: (id: string, label: string) => void
  onOpenCommits: (id: string, label: string) => void
  onModeChange: (mode: AgentMode) => void
}

/**
 * Native agent detail: header switcher, Reader/Terminal modes, polling output
 * pane, composer. One target identity; a null agent is an explicit empty
 * state — never a substituted agent. Reader stays mounted while Terminal is
 * active so drafts, preferences, and scroll position survive mode switches.
 */
export function AgentViewPanel({
  agent,
  agents,
  recents,
  connection,
  mode,
  terminal,
  active,
  onSwitch,
  onPrevious,
  onOpenDiff,
  onOpenCommits,
  onModeChange,
}: AgentViewPanelProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const outputRef = useRef('')
  const hasOther = recents.some((id) => id !== agent?.id)
  const [stopPrepared, setStopPrepared] = useState<PreparedAction | null>(null)
  const [stopBusy, setStopBusy] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)

  function askStop(): void {
    if (!agent) return
    setStopNote(null)
    api
      .prepare({ action: 'stop', targetId: agent.id })
      .then(setStopPrepared)
      .catch((err: unknown) => setStopNote(err instanceof Error ? err.message : 'could not prepare stop'))
  }

  function confirmStop(acceptWarnings: boolean): void {
    if (!agent || !stopPrepared?.confirmToken) return
    setStopBusy(true)
    api
      .execute({
        action: 'stop',
        targetId: agent.id,
        acceptWarnings,
        confirmToken: stopPrepared.confirmToken,
        requestId: newRequestId(),
      })
      .then(async (op) => {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const fresh = await api.operation(op.id).catch(() => null)
          if (fresh && fresh.state !== 'running') {
            setStopNote(fresh.state === 'done' ? '✓ agent stopped' : fresh.error ?? `stop ${fresh.state}`)
            return
          }
        }
        setStopNote('stop still running; check again shortly')
      })
      .catch((err: unknown) => setStopNote(err instanceof Error ? err.message : 'stop failed'))
      .finally(() => {
        setStopBusy(false)
        setStopPrepared(null)
      })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="safe-top shrink-0 border-b border-line bg-surface">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            onClick={() => setSwitcherOpen(true)}
            aria-label="Switch agent"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-fg">
                {agent ? `${agent.session}${agent.windowName ? `:${agent.windowName}` : ''}` : 'No agent selected'}
              </span>
              <span className="block truncate text-xs text-fg-muted">
                {agent ? `${agent.project} / ${agent.name}` : 'tap to choose an agent'}
              </span>
            </span>
            {agent && <StatusBadge status={agent.status} />}
            <span aria-hidden className="shrink-0 text-fg-muted">
              ▾
            </span>
          </button>
          <button
            onClick={onPrevious}
            disabled={!hasOther}
            aria-label="Previous agent"
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-muted"
          >
            ← Prev
          </button>
        </div>
        <div className="flex items-center gap-1.5 px-3 pb-2">
          <ModeControl mode={mode} disabled={!agent} onChange={onModeChange} />
          {agent && (
            <>
              <button
                onClick={() => onOpenDiff(agent.worktreeId, `${agent.project}/${agent.git?.branch ?? agent.name}`)}
                className="rounded-lg border border-line px-3 py-1 text-xs text-fg-muted"
              >
                Diff
              </button>
              <button
                onClick={() => onOpenCommits(agent.worktreeId, `${agent.project}/${agent.git?.branch ?? agent.name}`)}
                disabled={!agent.git}
                aria-label="Show commit history"
                className="rounded-lg border border-line px-3 py-1 text-xs text-fg-muted disabled:opacity-45"
              >
                Commits
              </button>
              <button
                onClick={askStop}
                disabled={stopBusy}
                className="rounded-lg border border-err/40 px-3 py-1 text-xs text-err disabled:opacity-45"
              >
                {stopBusy ? 'Stopping…' : '⏹ Stop'}
              </button>
              {stopNote && (
                <span className="truncate text-xs text-fg-muted" role="status">
                  {stopNote}
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {mode === 'terminal' && terminal && (
        <div className="flex min-h-0 flex-1 flex-col">{terminal}</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col" hidden={mode !== 'reader'} inert={mode !== 'reader'}>
        {agent ? (
          <>
            <OutputPane agent={agent} active={active} onOpenSwitcher={() => setSwitcherOpen(true)} outputRef={outputRef} />
            <Composer agent={agent} connection={connection} outputRef={outputRef} />
          </>
        ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm font-medium text-fg">No agent selected</p>
          <p className="max-w-xs text-xs text-fg-muted">
            Pick an agent to watch its output and send it messages.
          </p>
          <button
            onClick={() => setSwitcherOpen(true)}
            className="rounded-lg bg-accent/15 px-4 py-2 text-sm font-medium text-accent"
          >
            Choose agent
          </button>
        </div>
        )}
      </div>

      {stopPrepared && (
        <ConfirmDialog
          title="Stop agent"
          targetLabel={stopPrepared.targetLabel}
          warnings={stopPrepared.warnings}
          blocked={stopPrepared.blocked}
          confirmLabel="Stop agent"
          busy={stopBusy}
          onConfirm={confirmStop}
          onCancel={() => setStopPrepared(null)}
        />
      )}

      {switcherOpen && (
        <AgentSwitcher
          agents={agents}
          recents={recents}
          currentId={agent?.id ?? null}
          onPick={onSwitch}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  )
}
