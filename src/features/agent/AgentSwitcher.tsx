import { useMemo, useState } from 'react'
import type { AgentView } from '@shared/types'
import { BottomSheet } from '../../components/BottomSheet'
import { StatusBadge } from '../../components/StatusBadge'

/**
 * Searchable agent switcher: recents first (App-persisted order), then the
 * remaining agents from the snapshot. Current agent is highlighted.
 */
export function AgentSwitcher({
  agents,
  recents,
  currentId,
  onPick,
  onClose,
}: {
  agents: AgentView[]
  recents: string[]
  currentId: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')

  const ordered = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]))
    const out: AgentView[] = []
    for (const id of recents) {
      const a = byId.get(id)
      if (a) {
        out.push(a)
        byId.delete(id)
      }
    }
    for (const a of agents) if (byId.has(a.id)) out.push(a)
    const q = query.trim().toLowerCase()
    return q ? out.filter((a) => `${a.project} ${a.name}`.toLowerCase().includes(q)) : out
  }, [agents, recents, query])

  return (
    <BottomSheet title="Switch agent" onClose={onClose}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter agents…"
        aria-label="Filter agents"
        className="mb-2 min-h-[44px] w-full rounded-lg border border-line bg-surface-2 px-3 text-base text-fg placeholder:text-fg-muted/60 md:text-sm"
      />
      {ordered.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">No agents match.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {ordered.map((a) => {
            const current = a.id === currentId
            return (
              <li key={a.id}>
                <button
                  onClick={() => {
                    onPick(a.id)
                    onClose()
                  }}
                  aria-current={current || undefined}
                  className={`flex min-h-[48px] w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left ${
                    current ? 'border-accent bg-accent/10' : 'border-line'
                  }`}
                >
                  <span className="min-w-0">
                    <span className={`block truncate text-sm font-medium ${current ? 'text-accent' : 'text-fg'}`}>
                      {a.name}
                      {current && <span className="ml-2 text-[10px] font-normal opacity-70">current</span>}
                    </span>
                    <span className="block truncate text-xs text-fg-muted">
                      {a.project} · {a.session}
                    </span>
                  </span>
                  <StatusBadge status={a.status} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </BottomSheet>
  )
}
