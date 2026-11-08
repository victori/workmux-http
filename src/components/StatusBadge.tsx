import type { AgentStatus } from '@shared/types'

const LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  waiting: 'Waiting',
  done: 'Done',
  stale: 'Stale',
}

const DOT: Record<AgentStatus, string> = {
  working: 'bg-working',
  waiting: 'bg-waiting',
  done: 'bg-done',
  stale: 'bg-stale',
}

const TEXT: Record<AgentStatus, string> = {
  working: 'text-working',
  waiting: 'text-waiting',
  done: 'text-done',
  stale: 'text-stale',
}

export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${TEXT[status]}`}>
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${DOT[status]}${status === 'working' ? ' pulse-dot' : ''}`}
      />
      {LABEL[status]}
    </span>
  )
}

/** Bare colored dots, e.g. per-agent status on a worktree card. */
export function StatusDots({ statuses }: { statuses: AgentStatus[] }) {
  if (statuses.length === 0) return null
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${statuses.length} agents`}>
      {statuses.map((s, i) => (
        <span key={i} aria-hidden className={`h-2 w-2 rounded-full ${DOT[s]}`} />
      ))}
    </span>
  )
}
