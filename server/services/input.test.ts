import { describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '../config.js'
import { loadConfig } from '../config.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import type { StatusPayload, WorkmuxLike, WorktreeRecord } from '../adapters/workmux.js'
import { Discovery } from './discovery.js'
import { InputService, TargetGoneError, UnknownDeliveryError } from './input.js'

const cfg: AppConfig = { ...loadConfig({}), fixtureDir: null, repos: [] }

interface Call {
  paneId: string
  text: string
}

function fakeTmuxWithLog(paneIds: string[]): TmuxLike & {
  literals: Call[]
  keySets: string[][]
  events: string[]
  failNext: boolean
  gate: Promise<void> | null
} {
  const panes: TmuxPane[] = paneIds.map((id) => ({
    paneId: id,
    sessionName: 's',
    sessionId: '$1',
    windowIndex: 1,
    windowName: 'w',
    paneIndex: 0,
    paneActive: true,
    currentCommand: 'claude',
    width: 80,
    height: 24,
    dead: false,
    owned: false,
  }))
  const state = { failNext: false, gate: null as Promise<void> | null }
  const literals: Call[] = []
  const keySets: string[][] = []
  const events: string[] = []
  return {
    socket: '/tmp/fake',
    literals,
    keySets,
    events,
    get failNext() {
      return state.failNext
    },
    set failNext(v: boolean) {
      state.failNext = v
    },
    get gate() {
      return state.gate
    },
    set gate(v: Promise<void> | null) {
      state.gate = v
    },
    ping: async () => true,
    listSessions: async (): Promise<TmuxSession[]> => [],
    listPanes: async () => panes,
    paneExists: async (id) => panes.some((p) => p.paneId === id),
    capturePane: async () => '',
    sendLiteral: async (paneId, text) => {
      if (state.failNext) {
        state.failNext = false
        throw new Error('tmux: server closed the connection mid-command')
      }
      literals.push({ paneId, text })
      events.push(`start:${text}`)
      if (state.gate) await state.gate
      events.push(`end:${text}`)
    },
    sendKeys: async (paneId, keys) => {
      keySets.push([paneId, ...keys])
    },
    killPane: async () => undefined,
    createOwnedGroupedSession: async () => undefined,
    selectWindow: async () => undefined,
    killOwnedSession: async () => undefined,
    sessionExists: async () => false,
  }
}

function discoveryFor(paneIds: string[]): Discovery {
  const agents = paneIds.map((pane_id, i) => ({
    worktree: `wt${i}`,
    branch: 'b',
    project: 'p',
    project_path: '/p',
    status: 'waiting',
    elapsed_secs: 1,
    title: null,
    pane_id,
    workdir: '/p',
    agent_kind: 'claude',
    session: 's',
    window_name: 'w',
    updated_ts: Math.floor(Date.now() / 1000),
  }))
  const tmux: TmuxLike = {
    socket: '/tmp/fake',
    ping: async () => true,
    listSessions: async () => [],
    listPanes: async () =>
      agents.map((a) => ({
        paneId: a.pane_id,
        sessionName: 's',
        sessionId: '$1',
        windowIndex: 1,
        windowName: 'w',
        paneIndex: 0,
        paneActive: true,
        currentCommand: 'claude',
        width: 80,
        height: 24,
        dead: false,
        owned: false,
      })),
    paneExists: async (id) => paneIds.includes(id),
    capturePane: async () => '',
    sendLiteral: async () => undefined,
    sendKeys: async () => undefined,
    killPane: async () => undefined,
    createOwnedGroupedSession: async () => undefined,
    selectWindow: async () => undefined,
    killOwnedSession: async () => undefined,
    sessionExists: async () => false,
  }
  const workmux: WorkmuxLike = {
    version: async () => '0.1.280',
    listAll: async (): Promise<WorktreeRecord[]> => [],
    statusAll: async () =>
      ({ context: { backend: 'tmux', instance: '/s' }, scope: {}, agents, target_errors: [] }) satisfies StatusPayload,
  }
  return new Discovery(cfg, tmux, workmux)
}

describe('InputService', () => {
  test('should deliver literal message followed by Enter', async () => {
    const tmux = fakeTmuxWithLog(['%1'])
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    const res = await input.message('%1', 'hello world', 'r1')
    expect(res.delivered).toBe('sent')
    expect(tmux.literals).toEqual([{ paneId: '%1', text: 'hello world' }])
    expect(tmux.keySets).toEqual([['%1', 'Enter']])
  })

  test('should serialize submissions to the same pane without interleaving', async () => {
    const tmux = fakeTmuxWithLog(['%1'])
    let release: () => void = () => undefined
    tmux.gate = new Promise<void>((r) => {
      release = r
    })
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    const all = Promise.all([
      input.message('%1', 'one', 'r1'),
      input.message('%1', 'two', 'r2'),
      input.message('%1', 'three', 'r3'),
    ])
    await vi.waitFor(() => expect(tmux.events).toEqual(['start:one']))
    release()
    await all
    expect(tmux.events).toEqual(['start:one', 'end:one', 'start:two', 'end:two', 'start:three', 'end:three'])
    expect(tmux.literals.map((c) => c.text)).toEqual(['one', 'two', 'three'])
  })

  test('should dedupe by request identity', async () => {
    const tmux = fakeTmuxWithLog(['%1'])
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    await input.message('%1', 'once', 'same')
    const dup = await input.message('%1', 'once', 'same')
    expect(dup.detail).toBe('duplicate_request')
    expect(tmux.literals.length).toBe(1)
  })

  test('should not suppress delivery to a different pane via reused requestId', async () => {
    const tmux = fakeTmuxWithLog(['%1', '%2'])
    const input = new InputService(cfg, tmux, discoveryFor(['%1', '%2']))
    await input.message('%1', 'hello', 'shared')
    const second = await input.message('%2', 'hello', 'shared')
    expect(second.delivered).toBe('sent')
    expect(second.paneId).toBe('%2')
    expect(tmux.literals.map((c) => c.paneId)).toEqual(['%1', '%2'])
  })

  test('should deliver once for concurrent requests sharing a requestId', async () => {
    const tmux = fakeTmuxWithLog(['%1'])
    let release: () => void = () => undefined
    tmux.gate = new Promise<void>((res) => {
      release = res
    })
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    const a = input.message('%1', 'hi', 'race')
    const b = input.message('%1', 'hi', 'race')
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.delivered).toBe('sent')
    expect(rb.detail).toBe('duplicate_request')
    expect(tmux.literals.length).toBe(1)
  })

  test('should reject unmanaged targets', async () => {
    const tmux = fakeTmuxWithLog([])
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    await expect(input.message('%unmanaged', 'x', 'r1')).rejects.toThrow(TargetGoneError)
    expect(tmux.literals.length).toBe(0)
  })

  test('should report unknown delivery on ambiguous failure without retry', async () => {
    const tmux = fakeTmuxWithLog(['%1'])
    tmux.failNext = true
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    await expect(input.message('%1', 'x', 'r1')).rejects.toThrow(UnknownDeliveryError)
    expect(tmux.literals.length).toBe(0)
  })

  test('should map explicit keys to tmux key names', async () => {
    const tmux = fakeTmuxWithLog(['%1'])
    const input = new InputService(cfg, tmux, discoveryFor(['%1']))
    await input.keys('%1', ['ctrl-c', 'up', 'enter'], 'r9')
    expect(tmux.keySets).toEqual([['%1', 'C-c', 'Up', 'Enter']])
  })
})
