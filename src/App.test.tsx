// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentView, DashboardSnapshot } from '@shared/types'

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  }
}
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true })
}

const A1: AgentView = {
  id: '%1',
  name: 'coder',
  project: 'proj',
  projectPath: '/src/proj',
  worktreeId: 'wt_1',
  status: 'working',
  elapsedSecs: 1,
  title: null,
  agentKind: 'claude',
  session: 'sess',
  windowName: null,
  workdir: '/src/proj',
  git: null,
  updatedTs: 0,
}
const A2: AgentView = { ...A1, id: '%2', name: 'writer' }

const snapshot: DashboardSnapshot = {
  observedAt: 1,
  agents: [A1, A2],
  worktrees: [],
  sources: {
    workmuxList: { ok: true, at: 1 },
    workmuxStatus: { ok: true, at: 1 },
    tmux: { ok: true, at: 1 },
    git: { ok: true, at: 1 },
  },
  stale: false,
}

vi.mock('./hooks/useDashboard', () => ({
  useDashboard: () => ({
    snapshot,
    connection: 'online',
    lastOkAt: Date.now(),
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('./features/dashboard/DashboardView', () => ({
  DashboardView: (props: {
    onOpenAgent: (id: string) => void
    onOpenTerminal: (id: string) => void
  }) => (
    <div data-testid="dashboard">
      <button onClick={() => props.onOpenAgent('%1')}>dash-open-agent</button>
      <button onClick={() => props.onOpenTerminal('%2')}>dash-open-terminal</button>
    </div>
  ),
}))

vi.mock('./features/dashboard/SessionsView', () => ({
  SessionsView: () => <div data-testid="sessions" />,
}))

vi.mock('./features/worktrees/DiffView', () => ({
  DiffView: () => <div data-testid="diff" />,
}))

vi.mock('./features/worktrees/CreateWorktreeSheet', () => ({
  CreateWorktreeSheet: () => <div data-testid="create" />,
}))

vi.mock('./features/palette/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="palette" />,
}))

vi.mock('./features/agent/AgentView', () => ({
  AgentViewPanel: (props: {
    agent: AgentView | null
    mode: string
    active: boolean
    onSwitch: (id: string) => void
    onModeChange: (m: 'reader' | 'terminal') => void
  }) => (
    <div data-testid="reader" data-mode={props.mode} data-active={String(props.active)} data-agent={props.agent?.id ?? ''}>
      <button onClick={() => props.onModeChange('terminal')}>reader-to-terminal</button>
      <button onClick={() => props.onSwitch('%2')}>reader-switch</button>
    </div>
  ),
}))

vi.mock('./features/terminal/TerminalView', () => ({
  TerminalView: (props: { agentId: string; onClose: () => void }) => (
    <div data-testid="terminal" data-agent={props.agentId}>
      <button onClick={props.onClose}>terminal-close</button>
    </div>
  ),
}))

import App from './App'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(cleanup)

describe('App agent mode routing', () => {
  it('opens agents from the dashboard in reader mode with terminal unmounted', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-agent'))
    const reader = screen.getByTestId('reader')
    expect(reader).toHaveAttribute('data-mode', 'reader')
    expect(reader).toHaveAttribute('data-active', 'true')
    expect(reader).toHaveAttribute('data-agent', '%1')
    expect(screen.queryByTestId('terminal')).toBeNull()
  })

  it('dashboard terminal action opens terminal mode for the same target', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-terminal'))
    expect(screen.getByTestId('terminal')).toHaveAttribute('data-agent', '%2')
    const reader = screen.getByTestId('reader')
    expect(reader).toHaveAttribute('data-mode', 'terminal')
    expect(reader).toHaveAttribute('data-active', 'false')
    expect(reader).toHaveAttribute('data-agent', '%2')
  })

  it('reader stays mounted (drafts survive) while terminal is active', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-agent'))
    fireEvent.click(screen.getByText('reader-to-terminal'))
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
    expect(screen.getByTestId('reader')).toBeInTheDocument()
  })

  it('closing terminal returns to reader for the same agent', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-terminal'))
    fireEvent.click(screen.getByText('terminal-close'))
    expect(screen.queryByTestId('terminal')).toBeNull()
    const reader = screen.getByTestId('reader')
    expect(reader).toHaveAttribute('data-mode', 'reader')
    expect(reader).toHaveAttribute('data-agent', '%2')
  })

  it('Escape in terminal mode returns to reader', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-terminal'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.getByTestId('reader')).toHaveAttribute('data-mode', 'reader')
  })

  it('switching agents resets to reader mode and updates recents', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-terminal'))
    fireEvent.click(screen.getByText('reader-switch'))
    expect(screen.queryByTestId('terminal')).toBeNull()
    const reader = screen.getByTestId('reader')
    expect(reader).toHaveAttribute('data-agent', '%2')
    expect(reader).toHaveAttribute('data-mode', 'reader')
    expect(JSON.parse(sessionStorage.getItem('wmhttp-tab:recents') ?? '[]')).toEqual(['%2'])
  })

  it('persists selected agent id in tab storage', () => {
    render(<App />)
    fireEvent.click(screen.getByText('dash-open-agent'))
    expect(JSON.parse(sessionStorage.getItem('wmhttp-tab:agentId') ?? 'null')).toBe('%1')
  })
})
