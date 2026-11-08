import { describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '../config.js'
import { loadConfig } from '../config.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import { DependencyError, type StatusPayload, type WorkmuxLike, type WorktreeRecord } from '../adapters/workmux.js'
import { Discovery } from './discovery.js'
import { worktreeId } from '../targets.js'

const cfg: AppConfig = { ...loadConfig({}), fixtureDir: null, repos: [], staleAfterSecs: 3600 }

function pane(paneId: string, sessionName: string, overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId,
    sessionName,
    sessionId: `$1`,
    windowIndex: 1,
    windowName: 'w1',
    paneIndex: 0,
    paneActive: true,
    currentCommand: 'claude',
    width: 120,
    height: 30,
    dead: false,
    owned: false,
    ...overrides,
  }
}

function agentRecord(paneId: string, overrides: Partial<StatusPayload['agents'][number]> = {}) {
  return {
    worktree: 'wt-a',
    branch: 'feat',
    project: 'proj',
    project_path: '/repos/proj',
    status: 'waiting',
    elapsed_secs: 10,
    title: 't',
    pane_id: paneId,
    workdir: '/repos/proj',
    agent_kind: 'claude',
    session: 'shellfish-1',
    window_name: 'w1',
    updated_ts: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

function worktreeRecord(handle: string, overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    project: 'proj',
    project_path: '/repos/proj',
    handle,
    branch: 'feat',
    path: `/repos/proj/.claude/worktrees/${handle}`,
    is_main: false,
    mode: 'window',
    has_uncommitted_changes: true,
    is_open: true,
    agent_statuses: ['waiting'],
    created_at: 1700000000,
    ...overrides,
  }
}

interface FakeTmux extends TmuxLike {
  panes: TmuxPane[]
  sessions: TmuxSession[]
  failPanes: boolean
}

function fakeTmux(initialPanes: TmuxPane[], initialSessions: TmuxSession[] = []): FakeTmux {
  const state = { panes: initialPanes, sessions: initialSessions, failPanes: false }
  return {
    socket: '/tmp/fake',
    get panes() {
      return state.panes
    },
    get sessions() {
      return state.sessions
    },
    get failPanes() {
      return state.failPanes
    },
    set failPanes(v: boolean) {
      state.failPanes = v
    },
    ping: async () => true,
    listSessions: async () => state.sessions,
    listPanes: async () => {
      if (state.failPanes) throw new Error('tmux down')
      return state.panes
    },
    paneExists: async (id) => state.panes.some((p) => p.paneId === id && !p.dead),
    capturePane: async () => '',
    sendLiteral: async () => undefined,
    sendKeys: async () => undefined,
    killPane: async () => undefined,
    createOwnedGroupedSession: async () => undefined,
    selectWindow: async () => undefined,
    killOwnedSession: async () => undefined,
    sessionExists: async () => false,
  }
}

function fakeWorkmux(list: WorktreeRecord[], agents: ReturnType<typeof agentRecord>[]): WorkmuxLike {
  return {
    version: async () => '0.1.280',
    listAll: async () => list,
    statusAll: async () =>
      ({ context: { backend: 'tmux', instance: '/s' }, scope: {}, agents, target_errors: [] }) satisfies StatusPayload,
  }
}

describe('Discovery snapshot', () => {
  test('should map agents with stable pane-id identity and compute stale', async () => {
    const panes = [pane('%1', 'shellfish-1'), pane('%2', 'shellfish-1')]
    const discovery = new Discovery(
      cfg,
      fakeTmux(panes),
      fakeWorkmux(
        [worktreeRecord('wt-a')],
        [agentRecord('%1'), agentRecord('%2', { status: 'done', elapsed_secs: 999_999 })],
      ),
    )
    const snap = await discovery.snapshot()
    expect(snap.sources.workmuxList.ok).toBe(true)
    expect(snap.agents.map((a) => a.status)).toEqual(['waiting', 'stale'])
    expect(snap.agents[0]!.id).toBe('%1')
    expect(snap.agents[0]!.worktreeId).toBe(worktreeId('proj', '/repos/proj'))
  })

  test('should exclude agents whose pane is gone (unmanaged/dead)', async () => {
    const discovery = new Discovery(cfg, fakeTmux([pane('%1', 's')]), fakeWorkmux([], [agentRecord('%1'), agentRecord('%ghost')]))
    const snap = await discovery.snapshot()
    expect(snap.agents.map((a) => a.id)).toEqual(['%1'])
  })

  test('should exclude panes in owned terminal sessions', async () => {
    const tmux = fakeTmux(
      [pane('%1', 'shellfish-1'), pane('%9', 'wmhttp-adv-abcd1234')],
      [{ name: 'wmhttp-adv-abcd1234', id: '$5', groupName: 'g0', owned: true }],
    )
    const discovery = new Discovery(
      cfg,
      tmux,
      fakeWorkmux([], [agentRecord('%1'), agentRecord('%9', { session: 'wmhttp-adv-abcd1234' })]),
    )
    const snap = await discovery.snapshot()
    expect(snap.agents.map((a) => a.id)).toEqual(['%1'])
  })

  test('should keep duplicate worktree names as distinct agents', async () => {
    const discovery = new Discovery(
      cfg,
      fakeTmux([pane('%1', 's'), pane('%2', 's')]),
      fakeWorkmux([], [agentRecord('%1'), agentRecord('%2')]),
    )
    const snap = await discovery.snapshot()
    expect(snap.agents.length).toBe(2)
    expect(new Set(snap.agents.map((a) => a.id)).size).toBe(2)
  })

  test('should treat empty observations as valid empty snapshot', async () => {
    const discovery = new Discovery(cfg, fakeTmux([]), fakeWorkmux([], []))
    const snap = await discovery.snapshot()
    expect(snap.agents).toEqual([])
    expect(snap.worktrees).toEqual([])
    expect(snap.stale).toBe(false)
    expect(Object.values(snap.sources).every((s) => s.ok)).toBe(true)
  })

  test('should mark source errors and stay stale when tmux fails, keeping last good data', async () => {
    const tmux = fakeTmux([pane('%1', 's')])
    const discovery = new Discovery(cfg, tmux, fakeWorkmux([worktreeRecord('wt-a')], [agentRecord('%1')]))
    await discovery.snapshot()
    tmux.failPanes = true
    const snap = await discovery.snapshot(true)
    expect(snap.sources.tmux.ok).toBe(false)
    expect(snap.stale).toBe(true)
    expect(snap.agents.map((a) => a.id)).toEqual(['%1'])
  })

  test('should surface workmux dependency failure', async () => {
    const broken: WorkmuxLike = {
      version: async () => null,
      listAll: async () => {
        throw new DependencyError('workmux not found')
      },
      statusAll: async () => {
        throw new DependencyError('workmux not found')
      },
    }
    const discovery = new Discovery(cfg, fakeTmux([]), broken)
    await expect(discovery.snapshot()).resolves.toMatchObject({
      sources: { workmuxList: { ok: false }, workmuxStatus: { ok: false } },
      stale: true,
    })
  })

  test('should derive project from workdir when payload project is null', async () => {
    const discovery = new Discovery(
      cfg,
      fakeTmux([pane('%g', 's')]),
      fakeWorkmux([], [agentRecord('%g', { project: null, project_path: null, workdir: '/repos/fallback-app' })]),
    )
    const snap = await discovery.snapshot()
    expect(snap.agents[0]).toMatchObject({ project: 'fallback-app', projectPath: '/repos/fallback-app' })
  })

  test('should dedupe concurrent snapshot requests', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow: WorkmuxLike = {
      version: async () => '0.1.280',
      listAll: async () => {
        calls++
        await gate
        return []
      },
      statusAll: async () => ({ context: { backend: 'tmux', instance: '/s' }, scope: {}, agents: [], target_errors: [] }),
    }
    const discovery = new Discovery(cfg, fakeTmux([]), slow)
    const all = Promise.all([discovery.snapshot(), discovery.snapshot(), discovery.snapshot()])
    await vi.waitFor(() => expect(calls).toBe(1))
    release()
    await all
    expect(calls).toBe(1)
  })
})

describe('worktree identity', () => {
  test('should be stable for same project+path and differ across paths', () => {
    expect(worktreeId('p', '/a')).toBe(worktreeId('p', '/a'))
    expect(worktreeId('p', '/a')).not.toBe(worktreeId('p', '/b'))
    expect(worktreeId('p', '/a')).not.toBe(worktreeId('q', '/a'))
  })
})
