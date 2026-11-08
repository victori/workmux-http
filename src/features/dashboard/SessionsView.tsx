import type { ConnectionState } from '../../hooks/useDashboard'

export interface SessionRow {
  name: string
  agents: number
  worktrees: number
}

export interface SessionsViewProps {
  sessions: SessionRow[]
  activeSession: string | null
  onSelect: (name: string | null) => void
  connection: ConnectionState
}

export function SessionsView({ sessions, activeSession, onSelect, connection }: SessionsViewProps) {
  if (sessions.length === 0) {
    return (
      <div className="p-3">
        <h1 className="mb-3 text-base font-semibold text-fg">Sessions</h1>
        {connection === 'connecting' ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-2" />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm font-medium text-fg">No tmux sessions</p>
            <p className="mt-1 text-xs text-fg-muted">Start tmux or a workmux session to see it here.</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-3">
      <h1 className="mb-3 text-base font-semibold text-fg">Sessions</h1>
      <ul className="flex flex-col gap-1.5">
        <li>
          <button
            onClick={() => onSelect(null)}
            aria-pressed={activeSession === null}
            className={`flex min-h-[52px] w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left ${
              activeSession === null ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-fg-muted'
            }`}
          >
            <span className="text-sm font-medium">All sessions</span>
            <span className="text-xs tabular-nums">
              {sessions.reduce((n, s) => n + s.agents, 0)} agents · {sessions.reduce((n, s) => n + s.worktrees, 0)} worktrees
            </span>
          </button>
        </li>
        {sessions.map((s) => {
          const active = s.name === activeSession
          return (
            <li key={s.name}>
              <button
                onClick={() => onSelect(s.name)}
                aria-pressed={active}
                className={`flex min-h-[52px] w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left ${
                  active ? 'border-accent bg-accent/10' : 'border-line bg-surface'
                }`}
              >
                <span className={`min-w-0 truncate font-mono text-sm ${active ? 'text-accent' : 'text-fg'}`}>
                  {s.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                  {s.agents} agents · {s.worktrees} worktrees
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
