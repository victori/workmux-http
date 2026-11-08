import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import type { TerminalServerMessage } from '../../shared/types.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import type { Discovery } from './discovery.js'
import type { AppConfig } from '../config.js'
import { loadConfig } from '../config.js'

// Fake PTY: no native node-pty needed.
class FakePty {
  dataCb: ((s: string) => void) | null = null
  exitCb: ((e: { exitCode: number }) => void) | null = null
  killed = false
  onData(cb: (s: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb
  }
  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true
  }
}

vi.mock('node-pty', () => ({
  spawn: () => new FakePty(),
}))

const { TerminalHub } = await import('./terminal.js')

interface FakeSocket {
  readyState: number
  OPEN: number
  sent: TerminalServerMessage[]
  send(data: string): void
}

function fakeSocket(): FakeSocket {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    sent: [],
    send(data: string) {
      this.sent.push(JSON.parse(data) as TerminalServerMessage)
    },
  }
}

const pane: TmuxPane = {
  paneId: '%1',
  sessionId: '1',
  sessionName: 'workmux',
  windowIndex: 2,
  windowName: 'w',
  paneIndex: 1,
  paneActive: false,
  currentCommand: 'node',
  width: 80,
  height: 24,
  dead: false,
  owned: false,
}

function fakeTmux(activePaneId: () => string | null): TmuxLike {
  return {
    socket: '/tmp/fake.sock',
    ping: async () => true,
    listSessions: async (): Promise<TmuxSession[]> => [],
    listPanes: async () => [pane],
    paneExists: async () => true,
    capturePane: async () => '',
    sendLiteral: async () => undefined,
    sendKeys: async () => undefined,
    killPane: async () => undefined,
    createOwnedGroupedSession: async () => undefined,
    selectWindow: async () => undefined,
    activePane: async () => activePaneId(),
    killOwnedSession: async () => undefined,
    sessionExists: async () => false,
  }
}

const discoveryStub = {
  agentTargets: async () =>
    new Map([
      [
        '%1',
        { id: '%1', name: 'a', project: 'p', worktreeId: 'wt_1', status: 'working' },
      ],
    ]),
} as unknown as Discovery

const cfg: AppConfig = loadConfig({})

let activePane = () => '%9'
let hub: InstanceType<typeof TerminalHub>

beforeEach(() => {
  vi.useFakeTimers()
  activePane = () => '%9'
  hub = new TerminalHub(cfg, fakeTmux(() => activePane()), discoveryStub)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TerminalHub pane disclosure (F05)', () => {
  it('reports the window active pane on attach even when it differs from the agent', async () => {
    const ws = fakeSocket()
await hub.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    const attached = ws.sent.find((m) => m.type === 'attached')
    expect(attached?.type).toBe('attached')
    if (attached?.type === 'attached') {
      expect(attached.agentId).toBe('%1')
      expect(attached.activePaneId).toBe('%9')
    }
  })

  it('emits pane-changed when the window active pane moves while attached', async () => {
    const ws = fakeSocket()
    await hub.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    activePane = () => '%1'
    await vi.advanceTimersByTimeAsync(2100)
    expect(ws.sent.some((m) => m.type === 'pane-changed' && m.activePaneId === '%1')).toBe(true)
  })

  it('stops the watchdog after cleanup', async () => {
    const ws = fakeSocket()
    await hub.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    hub.close(ws as unknown as WebSocket)
    const before = ws.sent.length
    activePane = () => '%7'
    await vi.advanceTimersByTimeAsync(5000)
    expect(ws.sent.length).toBe(before) // only the detached message, no pane-changed
  })
})

describe('TerminalHub attach lifecycle (audit F04)', () => {
  function gatedHub(max: number) {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const spawned: FakePty[] = []
    const killedSessions: string[] = []
    const tmux = fakeTmux(() => '%9')
    const gated = {
      ...tmux,
      listPanes: async () => {
        await gate
        return [pane]
      },
      killOwnedSession: async (name: string) => {
        killedSessions.push(name)
      },
    } as unknown as TmuxLike
    const cfgGated = loadConfig({ WORKMUX_HTTP_MAX_OWNED_TERMINALS: String(max) })
    const h = new TerminalHub(cfgGated, gated, discoveryStub)
    return { h, release, spawned, killedSessions }
  }

  it('rejects a second concurrent attach at the limit while the first is still pending', async () => {
    const { h, release } = gatedHub(1)
    const ws1 = fakeSocket()
    const ws2 = fakeSocket()
    const p1 = h.handle(ws1 as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    await Promise.resolve()
    await h.handle(ws2 as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    expect(ws2.sent.some((m) => m.type === 'error' && /limit reached/.test(m.error))).toBe(true)
    release()
    await p1
    expect(ws1.sent.some((m) => m.type === 'attached')).toBe(true)
  })

  it('cancels a pending attach when the socket closes before dependencies resolve', async () => {
    const { h, release, killedSessions } = gatedHub(4)
    const ws = fakeSocket()
    const p = h.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    await Promise.resolve()
    h.close(ws as unknown as WebSocket)
    release()
    await p
    expect(ws.sent.some((m) => m.type === 'attached')).toBe(false)
    // Cancelled before the owned session was even created — nothing leaked.
    expect(killedSessions.length).toBe(0)
  })

  it('kills the owned session when the socket closes while the session is being created', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    const killedSessions: string[] = []
    const gated = {
      ...fakeTmux(() => '%9'),
      createOwnedGroupedSession: async () => {
        await gate
      },
      killOwnedSession: async (name: string) => {
        killedSessions.push(name)
      },
    } as unknown as TmuxLike
    const h = new TerminalHub(loadConfig({}), gated, discoveryStub)
    const ws = fakeSocket()
    const p = h.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    // Flush microtasks so attach reaches the gated createOwnedGroupedSession.
    for (let k = 0; k < 8; k++) await Promise.resolve()
    h.close(ws as unknown as WebSocket)
    releaseGate()
    await p
    expect(ws.sent.some((m) => m.type === 'attached')).toBe(false)
    expect(killedSessions.length).toBe(1) // created session cleaned up, not orphaned
  })

  it('repeated attaches on one socket never leave multiple registrations', async () => {
    const { h, release } = gatedHub(4)
    const ws = fakeSocket()
    const p1 = h.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    await Promise.resolve()
    const p2 = h.handle(ws as unknown as WebSocket, { type: 'attach', agentId: '%1', cols: 80, rows: 24 })
    release()
    await Promise.all([p1, p2])
    const attached = ws.sent.filter((m) => m.type === 'attached')
    expect(attached.length).toBe(1) // the stale attach was cancelled by the newer generation
  })
})
