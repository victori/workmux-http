import type { AgentView } from '@shared/types'
import { StatusBadge } from '../../components/StatusBadge'
import { humanizeElapsed } from './agentSort'

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
          <StatusBadge status={agent.status} />
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
      <div className="flex justify-end border-t border-line px-2 py-1">
        <button
          onClick={() => onOpenTerminal(agent.id)}
          aria-label={`Open terminal for ${agent.name}`}
          className="min-h-0 px-2 py-1 text-xs text-fg-muted"
        >
          ⌨ Terminal
        </button>
      </div>
    </div>
  )
}
