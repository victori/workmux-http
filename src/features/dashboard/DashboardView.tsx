import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DashboardSnapshot, SortMode } from '@shared/types'
import type { ConnectionState } from '../../hooks/useDashboard'
import { loadPref, savePref } from '../../lib/storage'
import { SegmentedTabs } from '../../components/SegmentedTabs'
import { AgentCard } from './AgentCard'
import { WorktreeCard, worktreeLabel } from './WorktreeCard'
import { FilterSheet } from './FilterSheet'
import { ThemeSheet } from './ThemeSheet'
import { SweepSheet } from '../worktrees/SweepSheet'
import type { ThemeId } from '../../lib/themes'
import { filterAgents, filterWorktrees, sortAgents, sortWorktrees } from './agentSort'

export interface DashboardViewProps {
  snapshot: DashboardSnapshot | null
  connection: ConnectionState
  sessionFilter: string | null
  onClearSessionFilter: () => void
  onOpenAgent: (id: string) => void
  onOpenDiff: (id: string, label: string) => void
  onOpenTerminal: (id: string) => void
  onCreate: () => void
  onRefresh: () => void
  themeId: ThemeId
  onChangeTheme: (id: ThemeId) => void
}

type Tab = 'agents' | 'worktrees'

const SORT_LABEL: Record<SortMode, string> = {
  priority: 'Priority',
  project: 'Project',
  recency: 'Recency',
  natural: 'Natural',
}

const SOURCE_LABEL: Record<keyof DashboardSnapshot['sources'], string> = {
  workmuxList: 'workmux list',
  workmuxStatus: 'workmux status',
  tmux: 'tmux',
  git: 'git',
}

export function DashboardView({
  snapshot,
  connection,
  sessionFilter,
  onClearSessionFilter,
  onOpenAgent,
  onOpenDiff,
  onOpenTerminal,
  onCreate,
  onRefresh,
  themeId,
  onChangeTheme,
}: DashboardViewProps) {
  const [tab, setTab] = useState<Tab>(() => loadPref<Tab>('tab', 'agents'))
  const [sort, setSort] = useState<SortMode>(() => loadPref<SortMode>('sort', 'priority'))
  const [hideStale, setHideStale] = useState<boolean>(() => loadPref<boolean>('hideStale', false))
  const [query, setQuery] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [themeSheetOpen, setThemeSheetOpen] = useState(false)
  const [sweepOpen, setSweepOpen] = useState(false)
  const [sweepIds, setSweepIds] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  const changeTab = useCallback((next: Tab) => {
    setTab(next)
    savePref('tab', next)
    setSelectedId(null)
  }, [])

  const changeSort = useCallback((next: SortMode) => {
    setSort(next)
    savePref('sort', next)
  }, [])

  const changeHideStale = useCallback((next: boolean) => {
    setHideStale(next)
    savePref('hideStale', next)
  }, [])

  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot])
  const worktrees = useMemo(() => snapshot?.worktrees ?? [], [snapshot])
  const githubByWorktree = useMemo(() => new Map(worktrees.map((w) => [w.id, w.github])), [worktrees])

  const visibleAgents = useMemo(
    () => sortAgents(filterAgents(agents, { query, session: sessionFilter, hideStale }), sort),
    [agents, query, sessionFilter, hideStale, sort],
  )
  const visibleWorktrees = useMemo(
    () => sortWorktrees(filterWorktrees(worktrees, { query, session: sessionFilter, hideStale }), sort),
    [worktrees, query, sessionFilter, hideStale, sort],
  )

  const failedSources = useMemo(
    () =>
      snapshot
        ? (Object.entries(snapshot.sources) as [keyof DashboardSnapshot['sources'], DashboardSnapshot['sources'][keyof DashboardSnapshot['sources']]][]).filter(
            ([, s]) => !s.ok,
          )
        : [],
    [snapshot],
  )

  const rowIds = tab === 'agents' ? visibleAgents.map((a) => a.id) : visibleWorktrees.map((w) => w.id)
  const rowIdsRef = useRef<string[]>([])
  rowIdsRef.current = rowIds

  const openRow = useCallback(
    (id: string) => {
      if (tab === 'agents') onOpenAgent(id)
      else {
        const wt = worktrees.find((w) => w.id === id)
        if (wt) onOpenDiff(wt.id, worktreeLabel(wt))
      }
    },
    [tab, worktrees, onOpenAgent, onOpenDiff],
  )
  const openRowRef = useRef(openRow)
  openRowRef.current = openRow

  // Hardware keyboard: '/' search, j/k (+ arrows) selection, Enter open, 1-9 quick jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const inField =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === '/' && !inField) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (inField) return
      const ids = rowIdsRef.current
      if (ids.length === 0) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedId((cur) => {
          const i = ids.indexOf(cur ?? '')
          return ids[Math.min(i + 1, ids.length - 1)] ?? null
        })
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedId((cur) => {
          const i = ids.indexOf(cur ?? '')
          return i <= 0 ? ids[0] ?? null : ids[i - 1] ?? null
        })
        return
      }
      if (e.key === 'Enter') {
        const cur = selectedIdRef.current
        if (cur && ids.includes(cur)) {
          e.preventDefault()
          openRowRef.current(cur)
        }
        return
      }
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const id = ids[n - 1]
        if (id) openRowRef.current(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtersActive = (sessionFilter ? 1 : 0) + (hideStale ? 1 : 0) + (sort !== 'priority' ? 1 : 0)

  if (!snapshot) {
    return (
      <div className="p-3" role="status" aria-busy="true">
        <div className="mb-3 h-9 animate-pulse rounded-lg bg-surface-2" />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
        {connection === 'connecting' && <p className="mt-3 text-center text-xs text-fg-muted">Loading dashboard…</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-base font-semibold text-fg">
            Dashboard
            <span className="ml-2 text-xs font-normal text-fg-muted">
              {agents.length} agents · {worktrees.length} worktrees
            </span>
          </h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onCreate}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-fg-muted"
            >
              + New
            </button>
            <button
              onClick={() => setSheetOpen(true)}
              aria-label="Filters"
              className={`relative rounded-lg border px-3 py-1.5 text-sm ${
                filtersActive > 0 ? 'border-accent text-accent' : 'border-line text-fg-muted'
              }`}
            >
              Filter
              {filtersActive > 0 && (
                <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-bg">
                  {filtersActive}
                </span>
              )}
            </button>
            <button
              onClick={() => setThemeSheetOpen(true)}
              aria-label="Theme"
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-fg-muted"
            >
              ⚙
            </button>
          </div>
        </div>

        <SegmentedTabs
          ariaLabel="Dashboard sections"
          options={[
            { id: 'agents', label: 'Agents' },
            { id: 'worktrees', label: 'Worktrees' },
          ]}
          value={tab}
          onChange={changeTab}
        />

        <div className="flex items-center gap-2">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects, branches… ( / )"
            aria-label="Search"
            className="min-h-[44px] flex-1 rounded-lg border border-line bg-surface-2 px-3 text-base text-fg placeholder:text-fg-muted/60 md:text-sm"
          />
          <button
            onClick={() => setSheetOpen(true)}
            className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-fg-muted"
          >
            {SORT_LABEL[sort]}
          </button>
          {tab === 'worktrees' && (
            <button
              onClick={() => {
                setSweepIds(visibleWorktrees.map((w) => w.id))
                setSweepOpen(true)
              }}
              disabled={visibleWorktrees.length === 0}
              className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs text-fg-muted disabled:opacity-40"
            >
              Clean sweep
            </button>
          )}
        </div>

        {(sessionFilter || hideStale) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {sessionFilter && (
              <button
                onClick={onClearSessionFilter}
                className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2.5 py-1 text-xs text-accent"
              >
                session: {sessionFilter} <span aria-hidden>✕</span>
              </button>
            )}
            {hideStale && (
              <button
                onClick={() => changeHideStale(false)}
                className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-fg-muted"
              >
                hide stale <span aria-hidden>✕</span>
              </button>
            )}
          </div>
        )}

        {failedSources.length > 0 && (
          <div role="alert" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            <span className="font-semibold">
              Incomplete data — failed: {failedSources.map(([k]) => SOURCE_LABEL[k]).join(', ')}
            </span>
            <ul className="mt-1 space-y-0.5 opacity-80">
              {failedSources.map(([k, s]) => (
                <li key={k}>
                  {SOURCE_LABEL[k]}: {!s.ok ? s.error : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      {tab === 'agents' ? (
        visibleAgents.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAgents.map((a, i) => (
              <AgentCard
                key={a.id}
                agent={a}
                github={githubByWorktree.get(a.worktreeId)}
                hotkey={i < 9 ? i + 1 : undefined}
                selected={a.id === selectedId}
                onOpen={onOpenAgent}
                onOpenTerminal={onOpenTerminal}
              />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <EmptyState
            title="No managed sessions"
            body="workmux is not managing any agents yet. Create a worktree to start one."
            actionLabel="+ New worktree"
            onAction={onCreate}
          />
        ) : (
          <EmptyState title="No matches" body="Nothing matches the current filters." actionLabel="Clear search" onAction={() => setQuery('')} />
        )
      ) : visibleWorktrees.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visibleWorktrees.map((w, i) => (
            <WorktreeCard
              key={w.id}
              worktree={w}
              hotkey={i < 9 ? i + 1 : undefined}
              selected={w.id === selectedId}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </div>
      ) : worktrees.length === 0 ? (
        <EmptyState
          title="No worktrees"
          body="Create a worktree to start working on a project."
          actionLabel="+ New worktree"
          onAction={onCreate}
        />
      ) : (
        <EmptyState title="No matches" body="Nothing matches the current filters." actionLabel="Clear search" onAction={() => setQuery('')} />
      )}

      {sheetOpen && (
        <FilterSheet
          sort={sort}
          onSortChange={changeSort}
          hideStale={hideStale}
          onHideStaleChange={changeHideStale}
          sessionFilter={sessionFilter}
          onClearSessionFilter={onClearSessionFilter}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {sweepOpen && (
        <SweepSheet
          worktreeIds={sweepIds}
          onClose={() => setSweepOpen(false)}
          onChanged={onRefresh}
        />
      )}
      {themeSheetOpen && (
        <ThemeSheet
          themeId={themeId}
          onSelect={onChangeTheme}
          onClose={() => setThemeSheetOpen(false)}
        />
      )}
    </div>
  )
}

function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-10 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      <p className="max-w-xs text-xs text-fg-muted">{body}</p>
      {actionLabel && onAction && (
        <button onClick={onAction} className="mt-1 rounded-lg border border-line px-4 py-2 text-sm text-accent">
          {actionLabel}
        </button>
      )}
    </div>
  )
}
