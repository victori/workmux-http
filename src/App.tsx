import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentView } from '@shared/types'
import { useDashboard } from './hooks/useDashboard'
import { loadTab, saveTab } from './lib/storage'
import { DashboardView } from './features/dashboard/DashboardView'
import { SessionsView } from './features/dashboard/SessionsView'
import { AgentViewPanel } from './features/agent/AgentView'
import { DiffView } from './features/worktrees/DiffView'
import { CreateWorktreeSheet } from './features/worktrees/CreateWorktreeSheet'
import { TerminalView } from './features/terminal/TerminalView'
import { CommandPalette } from './features/palette/CommandPalette'
import { ConnectionStateBanner } from './components/ConnectionStateBanner'

type Route =
  | { view: 'dashboard' }
  | { view: 'sessions' }
  | { view: 'agent' }
  | { view: 'diff'; worktreeId: string; label: string }
  | { view: 'terminal'; agentId: string }

const NAV_TABS = [
  { view: 'dashboard', label: 'Dashboard', icon: '▦' },
  { view: 'sessions', label: 'Sessions', icon: '▤' },
  { view: 'agent', label: 'Agent', icon: '▶' },
] as const

export default function App() {
  const dash = useDashboard()
  const [route, setRoute] = useState<Route>({ view: 'dashboard' })
  const [agentId, setAgentId] = useState<string | null>(() => loadTab<string | null>('agentId', null))
  const [recents, setRecents] = useState<string[]>(() => loadTab<string[]>('recents', []))
  const [sessionFilter, setSessionFilter] = useState<string | null>(() => loadTab<string | null>('sessionFilter', null))
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const agents = dash.snapshot?.agents ?? []
  const worktrees = dash.snapshot?.worktrees ?? []
  const currentAgent: AgentView | null = useMemo(
    () => agents.find((a) => a.id === agentId) ?? null,
    [agents, agentId],
  )

  const openAgent = useCallback((id: string) => {
    setAgentId(id)
    saveTab('agentId', id)
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 20)
      saveTab('recents', next)
      return next
    })
    setRoute({ view: 'agent' })
  }, [])

  const goPrevious = useCallback(() => {
    const prev = recents.find((id) => id !== agentId)
    if (prev) openAgent(prev)
  }, [recents, agentId, openAgent])

  // Hardware keyboard: Alt+Left previous agent; Esc dismisses overlays/detail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('[data-terminal-root]'))
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevious()
        return
      }
      if (e.key === 'Escape' && !inField) {
        if (paletteOpen || createOpen) {
          setPaletteOpen(false)
          setCreateOpen(false)
        } else if (route.view === 'diff' || route.view === 'terminal') {
          setRoute({ view: 'agent' })
        }
      }
      if ((e.key === ':' || (e.shiftKey && e.key === 'P' && (e.metaKey || e.ctrlKey))) && !inField) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrevious, paletteOpen, createOpen, route.view])

  const sessions = useMemo(() => {
    const map = new Map<string, { agents: number; worktrees: number }>()
    for (const a of agents) {
      const e = map.get(a.session) ?? { agents: 0, worktrees: 0 }
      e.agents += 1
      map.set(a.session, e)
    }
    for (const w of worktrees) {
      if (w.isOpen) {
        const key = w.mode === 'session' ? w.handle : w.project
        const e = map.get(key) ?? { agents: 0, worktrees: 0 }
        e.worktrees += 1
        map.set(key, e)
      }
    }
    return [...map.entries()].map(([name, counts]) => ({ name, ...counts }))
  }, [agents, worktrees])

  const selectSession = useCallback((name: string | null) => {
    setSessionFilter(name)
    saveTab('sessionFilter', name)
    setRoute({ view: 'dashboard' })
  }, [])

  const navView = route.view

  return (
    <div className="dvh flex flex-col md:flex-row">
      {/* iPad persistent sidebar */}
      <aside className="hidden md:flex md:w-56 lg:w-64 md:flex-col md:border-r md:border-line md:bg-surface safe-top">
        <div className="px-4 py-3 text-sm font-semibold text-fg-muted">workmux</div>
        <nav className="flex flex-col gap-1 px-2">
          {NAV_TABS.map((t) => (
            <button
              key={t.view}
              onClick={() => setRoute({ view: t.view })}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                navView === t.view ? 'bg-surface-2 text-accent' : 'text-fg-muted hover:bg-surface-2'
              }`}
            >
              <span aria-hidden>{t.icon}</span>
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setCreateOpen(true)}
            className="mt-2 rounded-lg border border-line px-3 py-2 text-left text-sm text-fg-muted hover:bg-surface-2"
          >
            + New worktree
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="rounded-lg border border-line px-3 py-2 text-left text-sm text-fg-muted hover:bg-surface-2"
          >
            ⌘P Commands <span className="text-fg-muted/60">(:)</span>
          </button>
        </nav>
        <div className="mt-auto px-4 py-3 text-xs text-fg-muted">
          {dash.snapshot ? `${agents.length} agents · ${worktrees.length} worktrees` : '—'}
        </div>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col">
        <ConnectionStateBanner
          connection={dash.connection}
          error={dash.error}
          onRetry={() => dash.refresh(true)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {route.view === 'dashboard' && (
            <DashboardView
              snapshot={dash.snapshot}
              connection={dash.connection}
              sessionFilter={sessionFilter}
              onClearSessionFilter={() => selectSession(null)}
              onOpenAgent={openAgent}
              onOpenDiff={(id, label) => setRoute({ view: 'diff', worktreeId: id, label })}
              onOpenTerminal={openAgentTerminal}
              onCreate={() => setCreateOpen(true)}
            />
          )}
          {route.view === 'sessions' && (
            <SessionsView
              sessions={sessions}
              activeSession={sessionFilter}
              onSelect={selectSession}
              connection={dash.connection}
            />
          )}
          {route.view === 'agent' && (
            <AgentViewPanel
              agent={currentAgent}
              agents={agents}
              recents={recents}
              connection={dash.connection}
              onSwitch={openAgent}
              onPrevious={goPrevious}
              onOpenDiff={(id, label) => setRoute({ view: 'diff', worktreeId: id, label })}
              onOpenTerminal={(id) => setRoute({ view: 'terminal', agentId: id })}
            />
          )}
          {route.view === 'diff' && (
            <DiffView
              worktreeId={route.worktreeId}
              label={route.label}
              onClose={() => setRoute(currentAgent ? { view: 'agent' } : { view: 'dashboard' })}
              connection={dash.connection}
            />
          )}
          {route.view === 'terminal' && (
            <TerminalView
              agentId={route.agentId}
              agentLabel={`${currentAgent?.project ?? ''}/${currentAgent?.name ?? route.agentId}`}
              onClose={() => setRoute({ view: 'agent' })}
            />
          )}
        </div>

        {/* iPhone bottom navigation */}
        <nav className="safe-bottom flex shrink-0 border-t border-line bg-surface md:hidden">
          {NAV_TABS.map((t) => (
            <button
              key={t.view}
              onClick={() => setRoute({ view: t.view })}
              aria-label={t.label}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
                navView === t.view ? 'text-accent' : 'text-fg-muted'
              }`}
            >
              <span aria-hidden className="text-base leading-none">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </main>

      {paletteOpen && (
        <CommandPalette
          agents={agents}
          worktrees={worktrees}
          onClose={() => setPaletteOpen(false)}
          onOpenAgent={openAgent}
          onOpenDiff={(id, label) => {
            setPaletteOpen(false)
            setRoute({ view: 'diff', worktreeId: id, label })
          }}
          onCreate={() => {
            setPaletteOpen(false)
            setCreateOpen(true)
          }}
          onGoPrevious={goPrevious}
        />
      )}
      {createOpen && <CreateWorktreeSheet onClose={() => setCreateOpen(false)} />}
    </div>
  )

  function openAgentTerminal(id: string): void {
    setRoute({ view: 'terminal', agentId: id })
  }
}
