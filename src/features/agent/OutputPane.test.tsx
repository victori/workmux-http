// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentView } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { OutputPane } from './OutputPane'

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

vi.mock('../../lib/api', async (orig) => ({...(await orig() as object),
  ApiError: class ApiError extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, body: Record<string, unknown>) {
      super(String(body.error ?? `http ${status}`))
      this.status = status
      this.body = body
    }
  },
  api: { output: vi.fn(), message: vi.fn(), key: vi.fn() },
  terminalWsUrl: () => 'ws://localhost/api/terminal',
}))

const AGENT: AgentView = {
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

const out = (text: string) => ({ paneId: '%1', text, lines: 1, truncated: false, observedAt: 0 })

function renderPane(over: { agent?: AgentView | null; active?: boolean } = {}) {
  return render(
    <OutputPane
      agent={over.agent ?? AGENT}
      active={over.active ?? true}
      onOpenSwitcher={() => undefined}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.output).mockResolvedValue(out('first screen'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('OutputPane polling lifecycle', () => {
  it('fetches immediately when active and not at all when inactive', async () => {
    renderPane({ active: false })
    expect(api.output).not.toHaveBeenCalled()
    const { rerender } = renderPane({ active: true })
    await waitFor(() => expect(api.output).toHaveBeenCalledWith('%1'))
    rerender(
      <OutputPane agent={AGENT} active={false} onOpenSwitcher={() => undefined} />,
    )
    const calls = vi.mocked(api.output).mock.calls.length
    await new Promise((r) => setTimeout(r, 2100))
    expect(vi.mocked(api.output).mock.calls.length).toBe(calls)
  })

  it('drops late responses after the target changes', async () => {
    let resolveSlow: (v: ReturnType<typeof out>) => void = () => undefined
    vi.mocked(api.output).mockImplementationOnce(
      () => new Promise((r) => { resolveSlow = r }),
    )
    const { container, rerender } = renderPane()
    await waitFor(() => expect(api.output).toHaveBeenCalled())
    // switch agent while the first response is still in flight
    rerender(<OutputPane agent={{ ...AGENT, id: '%2' }} active onOpenSwitcher={() => undefined} />)
    await waitFor(() => expect(api.output).toHaveBeenCalledWith('%2'))
    resolveSlow(out('STALE %1 SCREEN'))
    await new Promise((r) => setTimeout(r, 50))
    expect(container.textContent).not.toContain('STALE')
  })

  it('overlapping polls are suppressed while one is in flight', async () => {
    vi.useFakeTimers()
    vi.mocked(api.output).mockImplementation(() => new Promise(() => undefined))
    renderPane()
    expect(api.output).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(api.output).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

describe('OutputPane error handling', () => {
  it('keeps the last snapshot and shows a notice on transient failure, then recovers', async () => {
    const { container } = renderPane()
    await waitFor(() => expect(container.textContent).toContain('first screen'))
    vi.mocked(api.output).mockRejectedValueOnce(new Error('tmux capture failed'))
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('showing last snapshot'),
      { timeout: 3000 },
    )
    expect(container.textContent).toContain('first screen')
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 3000 })
  })

  it('keeps target-gone distinct from transient errors', async () => {
    renderPane()
    await waitFor(() => expect(api.output).toHaveBeenCalled())
    vi.mocked(api.output).mockRejectedValue(new ApiError(410, { error: 'gone' }))
    await waitFor(() => expect(screen.getByText('target ended')).toBeInTheDocument(), { timeout: 3000 })
    expect(screen.queryByText('showing last snapshot')).toBeNull()
  })
})

describe('OutputPane snapshot rendering', () => {
  it('renders markup-like text safely (no injected elements)', async () => {
    vi.mocked(api.output).mockResolvedValue(out('<img src=x onerror="alert(1)">hi'))
    const { container } = renderPane()
    await waitFor(() => expect(container.textContent).toContain('hi'))
    expect(container.querySelector('img')).toBeNull()
  })

  it('leaves the DOM untouched when the screen is unchanged', async () => {
    const { container } = renderPane()
    await waitFor(() => expect(container.textContent).toContain('first screen'))
    const inner = container.querySelector('.terminal-output > div')
    await new Promise((r) => setTimeout(r, 2100))
    expect(vi.mocked(api.output).mock.calls.length).toBeGreaterThan(1)
    expect(container.querySelector('.terminal-output > div')).toBe(inner)
  })
})

describe('OutputPane preferences', () => {
  it('steps text size and persists the preset', async () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }))
    expect(localStorage.getItem('wmhttp:textSize')).toBe('"large"')
    fireEvent.click(screen.getByRole('button', { name: 'Decrease text size' }))
    expect(localStorage.getItem('wmhttp:textSize')).toBe('"normal"')
  })

  it('falls back to the default size for invalid stored values', async () => {
    localStorage.setItem('wmhttp:textSize', '"gigantic"')
    const { container } = renderPane()
    const box = container.querySelector('.terminal-output')
    expect(box).toHaveStyle({ fontSize: '12px' })
  })

  it('disables stepping at the boundaries', () => {
    localStorage.setItem('wmhttp:textSize', '"huge"')
    renderPane()
    expect(screen.getByRole('button', { name: 'Increase text size' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decrease text size' })).not.toBeDisabled()
  })

  it('persists the wrap toggle', async () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: /Wrap lines on/i }))
    expect(localStorage.getItem('wmhttp:wrap')).toBe('false')
    expect(screen.getByRole('button', { name: /Wrap lines off/i })).toBeInTheDocument()
  })
})
