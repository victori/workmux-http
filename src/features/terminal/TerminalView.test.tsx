// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { THEMES } from '../../lib/themes'
import { TerminalView } from './TerminalView'

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

interface FakeTermInstance {
  cols: number
  rows: number
  options: Record<string, unknown>
  open: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  loadAddon: ReturnType<typeof vi.fn>
}

const terms: FakeTermInstance[] = []
const fitInstances: { fit: ReturnType<typeof vi.fn>; proposeDimensions: ReturnType<typeof vi.fn> }[] = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    open = vi.fn()
    write = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    constructor() {
      terms.push(this as unknown as FakeTermInstance)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FakeFitAddon {
    fit = vi.fn()
    proposeDimensions = vi.fn(() => ({ cols: 100, rows: 50 }))
    constructor() {
      fitInstances.push(this as never)
    }
  },
}))

vi.mock('../../lib/api', async (orig) => ({...(await orig() as object),
  api: {},
  ApiError: class ApiError extends Error {},
  terminalWsUrl: () => 'ws://test/api/terminal',
}))

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  lastAttach(): Record<string, unknown> {
    const raw = this.sent.find((s) => JSON.parse(s).type === 'attach')
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  }
  sentTypes(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type)
  }
}

const latest = <T,>(arr: T[]): T => arr[arr.length - 1]!

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  terms.length = 0
  fitInstances.length = 0
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderView() {
  return render(
    <TerminalView agentId="%1" agentLabel="proj / coder" theme={THEMES.night.xterm} onClose={() => undefined} />,
  )
}

describe('TerminalView entry geometry', () => {
  it('does not fit on mount — preserves the default grid until the server reports', async () => {
    renderView()
    await waitFor(() => expect(latest(FakeSocket.instances).sentTypes()).toContain('attach'))
    expect(latest(fitInstances).fit).not.toHaveBeenCalled()
    expect(latest(fitInstances).proposeDimensions).not.toHaveBeenCalled()
  })

  it('applies the server grid on attach ack and labels it server size', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() => ws.emit({ type: 'attached', agentId: '%1', sessionId: 'wmhttp-adv-x', cols: 132, rows: 43 }))
    expect(latest(terms).resize).toHaveBeenCalledWith(132, 43)
    expect(screen.getByText(/132×43 · server size/)).toBeInTheDocument()
  })

  it('discloses when the window active pane differs from the agent (F05)', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() =>
      ws.emit({ type: 'attached', agentId: '%1', sessionId: 'wmhttp-adv-x', cols: 80, rows: 24, activePaneId: '%9' }),
    )
    expect(screen.getByRole('status')).toHaveTextContent(/active pane is %9.*keystrokes go there/i)
    act(() => ws.emit({ type: 'pane-changed', activePaneId: '%1' }))
    expect(screen.queryByText(/active pane is/)).not.toBeInTheDocument()
    act(() => ws.emit({ type: 'pane-changed', activePaneId: '%3' }))
    expect(screen.getByRole('status')).toHaveTextContent(/active pane is now %3/i)
  })

  it('rotation and keyboard-driven resizes never send a fit message', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() => ws.emit({ type: 'attached', agentId: '%1', sessionId: 'wmhttp-adv-x', cols: 132, rows: 43 }))
    act(() => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('orientationchange'))
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(ws.sentTypes()).not.toContain('fit')
    expect(latest(fitInstances).fit).not.toHaveBeenCalled()
  })
})

describe('TerminalView explicit resize', () => {
  /** jsdom reports 0 metrics; stub the visible viewport (audit F09). */
  function stubViewport(width: number, height: number): void {
    const vp = document.querySelector('[data-terminal-root]') as HTMLElement
    Object.defineProperty(vp, 'clientWidth', { value: width, configurable: true })
    Object.defineProperty(vp, 'clientHeight', { value: height, configurable: true })
  }

  it('resize button opens a confirm dialog; cancel sends nothing', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() => ws.emit({ type: 'attached', agentId: '%1', sessionId: 'wmhttp-adv-x', cols: 132, rows: 43 }))
    stubViewport(390, 400)
    fireEvent.click(screen.getByRole('button', { name: /Resize shared terminal/ }))
    expect(screen.getByText('Resize shared terminal')).toBeInTheDocument()
    expect(screen.getByText(/every client attached to it/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(ws.sentTypes()).not.toContain('fit')
    expect(latest(fitInstances).fit).not.toHaveBeenCalled()
  })

  it('proposals come from the visible viewport, never the expanded grid (F09)', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() => ws.emit({ type: 'attached', agentId: '%1', sessionId: 'wmhttp-adv-x', cols: 132, rows: 43 }))
    // Viewport 390px wide vs a 132-col server grid: the proposal must be
    // viewport-sized (~54 cols), not grid-sized.
    stubViewport(390, 400)
    fireEvent.click(screen.getByRole('button', { name: /Resize shared terminal/ }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Resize for all clients' }))
    expect(ws.sentTypes()).toContain('fit')
    const fitMsg = JSON.parse(ws.sent.find((s) => JSON.parse(s).type === 'fit')!)
    expect(fitMsg).toMatchObject({ cols: 54, rows: 23 })
    // No local resize before the server acks (audit F09 second half).
    expect(latest(fitInstances).fit).not.toHaveBeenCalled()
    expect(latest(terms).resize).not.toHaveBeenCalledWith(54, 23)
    expect(screen.getByText(/server size/)).toBeInTheDocument()
    act(() => ws.emit({ type: 'resized', cols: 54, rows: 23 }))
    expect(latest(terms).resize).toHaveBeenCalledWith(54, 23)
    expect(screen.getByText(/54×23 · resized to fit/)).toBeInTheDocument()
  })

  it('refuses to propose when the viewport cannot be measured', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() => ws.emit({ type: 'attached', agentId: '%1', sessionId: 'wmhttp-adv-x', cols: 132, rows: 43 }))
    // jsdom default clientWidth 0 → below the 20-col floor.
    fireEvent.click(screen.getByRole('button', { name: /Resize shared terminal/ }))
    expect(screen.getByText(/cannot measure available space/i)).toBeInTheDocument()
    expect(ws.sentTypes()).not.toContain('fit')
  })

  it('resize is disabled before attach', () => {
    renderView()
    expect(screen.getByRole('button', { name: /Resize shared terminal/ })).toBeDisabled()
  })
})

describe('TerminalView transport', () => {
  it('unmount sends detach and disposes the terminal', async () => {
    const { unmount } = renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    unmount()
    expect(ws.sentTypes()).toContain('detach')
    expect(ws.closed).toBe(true)
    expect(latest(terms).dispose).toHaveBeenCalled()
  })

  it('reconnect re-attaches the same target on the same component', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    act(() => ws.emit({ type: 'detached', reason: 'pty exited' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    const ws2 = latest(FakeSocket.instances)
    expect(ws2).not.toBe(ws)
    await waitFor(() => expect(ws2.sentTypes()).toContain('attach'))
    expect(ws2.lastAttach()).toMatchObject({ agentId: '%1' })
  })

  it('forwarded input goes to the open socket', async () => {
    renderView()
    const ws = latest(FakeSocket.instances)
    await waitFor(() => expect(ws.sentTypes()).toContain('attach'))
    const onDataCb = latest(terms).onData.mock.calls[0]![0] as (d: string) => void
    onDataCb('ls\r')
    expect(ws.sentTypes()).toContain('input')
  })
})
