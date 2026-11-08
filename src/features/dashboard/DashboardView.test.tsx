// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentView, DashboardSnapshot, WorktreeView } from '@shared/types'
import { DashboardView } from './DashboardView'

// vitest 3 + jsdom 27 on this toolchain don't expose Web Storage; shim it.
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
}
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true })
}

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {
    status = 0
    body = {}
  },
  api: {
    prepare: vi.fn(),
    execute: vi.fn(),
    operation: vi.fn(),
  },
}))

function agent(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    name: over.id,
    project: 'alpha',
    projectPath: '/src/alpha',
    worktreeId: `wt_${over.id}`,
    status: 'working',
    elapsedSecs: 42,
    title: null,
    agentKind: null,
    session: 'main',
    windowName: null,
    workdir: '/src/alpha',
    git: null,
    updatedTs: 0,
    ...over,
  }
}

function worktree(over: Partial<WorktreeView> & { id: string }): WorktreeView {
  return {
    project: 'beta',
    projectPath: '/src/beta',
    handle: over.id,
    branch: `feat/${over.id}`,
    path: `/src/beta/${over.id}`,
    isMain: false,
    mode: 'window',
    hasUncommittedChanges: true,
    isOpen: true,
    agentStatuses: ['waiting'],
    createdAt: 0,
    prUrl: 'https://github.com/o/r/pull/1',
    ...over,
  }
}

const ok = { ok: true as const, at: 1 }
const sourcesOk = { workmuxList: ok, workmuxStatus: ok, tmux: ok, git: ok }

function snapshot(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    observedAt: 1,
    agents: [agent({ id: '%1', name: 'coder', project: 'alpha', status: 'waiting' })],
    worktrees: [worktree({ id: 'wt_1' })],
    sources: sourcesOk,
    stale: false,
    ...over,
  }
}

function renderView(snap: DashboardSnapshot | null) {
  return render(
    <DashboardView
      snapshot={snap}
      connection={snap ? 'online' : 'connecting'}
      sessionFilter={null}
      onClearSessionFilter={() => {}}
      onOpenAgent={vi.fn()}
      onOpenDiff={vi.fn()}
      onOpenTerminal={vi.fn()}
      onCreate={vi.fn()}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(cleanup)

describe('DashboardView', () => {
  it('renders agent cards from a snapshot', () => {
    renderView(snapshot())
    expect(screen.getByText('coder')).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('42s')).toBeInTheDocument()
    expect(screen.getByText('Waiting')).toBeInTheDocument()
  })

  it('segmented tab switches to worktrees', () => {
    renderView(snapshot())
    fireEvent.click(screen.getByRole('tab', { name: 'Worktrees' }))
    expect(screen.getByText('feat/wt_1')).toBeInTheDocument()
    expect(screen.getByText('dirty')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /PR/ })).toHaveAttribute('href', 'https://github.com/o/r/pull/1')
    expect(screen.queryByText('coder')).not.toBeInTheDocument()
  })

  it('search filters agents case-insensitively', () => {
    renderView(
      snapshot({
        agents: [
          agent({ id: '%1', name: 'coder', project: 'alpha' }),
          agent({ id: '%2', name: 'writer', project: 'zeta' }),
        ],
      }),
    )
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'ZETA' } })
    expect(screen.getByText('writer')).toBeInTheDocument()
    expect(screen.queryByText('coder')).not.toBeInTheDocument()
  })

  it('shows empty state when snapshot has no agents', () => {
    renderView(snapshot({ agents: [], worktrees: [] }))
    expect(screen.getByText('No managed sessions')).toBeInTheDocument()
  })

  it('names failed sources when a dependency errored', () => {
    renderView(
      snapshot({
        stale: true,
        sources: { ...sourcesOk, git: { ok: false, error: 'git unavailable', at: 1 } },
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('git unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent('git')
  })

  it('persists sort choice to wmhttp:sort', () => {
    renderView(snapshot())
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.click(screen.getByRole('radio', { name: /Recency/ }))
    expect(localStorage.getItem('wmhttp:sort')).toBe('"recency"')
  })

  it('renders a loading skeleton when snapshot is null', () => {
    renderView(null)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('coder')).not.toBeInTheDocument()
  })
})
