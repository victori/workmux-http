import type { AgentStatus, AgentView, SortMode, WorktreeView } from '@shared/types'

/** Waiting agents need attention first; stale last. */
const PRIORITY: Record<AgentStatus, number> = { waiting: 0, done: 1, working: 2, stale: 3 }

export function humanizeElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Truncate long paths in the middle, keeping head and tail readable. */
export function truncateMiddle(text: string, max = 34): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export function sortAgents(agents: AgentView[], mode: SortMode): AgentView[] {
  const out = [...agents]
  switch (mode) {
    case 'priority':
      out.sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status])
      break
    case 'project':
      out.sort(
        (a, b) => a.project.localeCompare(b.project) || PRIORITY[a.status] - PRIORITY[b.status],
      )
      break
    case 'recency':
      out.sort((a, b) => b.updatedTs - a.updatedTs)
      break
    case 'natural':
      break
  }
  return out
}

export interface FilterOpts {
  query?: string
  session?: string | null
  hideStale?: boolean
}

export function filterAgents(agents: AgentView[], opts: FilterOpts): AgentView[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  return agents.filter((a) => {
    if (opts.session && a.session !== opts.session) return false
    if (opts.hideStale && a.status === 'stale') return false
    if (q && !`${a.project} ${a.name}`.toLowerCase().includes(q)) return false
    return true
  })
}

/** Session a worktree lives in, mirroring App's session aggregation. */
export function worktreeSessionKey(w: WorktreeView): string {
  return w.mode === 'session' ? w.handle : w.project
}

/** Worst (most attention-needed) agent status on a worktree; stale when no agents. */
function worktreePriority(w: WorktreeView): number {
  if (w.agentStatuses.length === 0) return PRIORITY.stale + 1
  return Math.min(...w.agentStatuses.map((s) => PRIORITY[s]))
}

export function filterWorktrees(worktrees: WorktreeView[], opts: FilterOpts): WorktreeView[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  return worktrees.filter((w) => {
    if (opts.session && worktreeSessionKey(w) !== opts.session) return false
    if (opts.hideStale && w.agentStatuses.length > 0 && w.agentStatuses.every((s) => s === 'stale'))
      return false
    if (q && ![w.project, w.handle, w.branch].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

export function sortWorktrees(worktrees: WorktreeView[], mode: SortMode): WorktreeView[] {
  const out = [...worktrees]
  switch (mode) {
    case 'priority':
      out.sort((a, b) => worktreePriority(a) - worktreePriority(b))
      break
    case 'project':
      out.sort((a, b) => a.project.localeCompare(b.project) || a.handle.localeCompare(b.handle))
      break
    case 'recency':
      out.sort((a, b) => b.createdAt - a.createdAt)
      break
    case 'natural':
      break
  }
  return out
}
