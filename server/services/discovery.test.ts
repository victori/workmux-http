import { describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AppConfig } from '../config.js'
import { loadConfig } from '../config.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import { DependencyError, type StatusPayload, type WorkmuxLike, type WorktreeRecord } from '../adapters/workmux.js'
import type { GithubStatus } from '../../shared/types.js'
import { Discovery } from './discovery.js'
import { GithubStatusService } from './github-status.js'
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

describe('non-agent pane filtering', () => {
  test('should exclude kind-less agent records (shells/dev servers) from the dashboard', async () => {
    const panes = [pane('%1', 's'), pane('%2', 's'), pane('%3', 's')]
    const discovery = new Discovery(
      cfg,
      fakeTmux(panes),
      fakeWorkmux(
        [worktreeRecord('wt-a')],
        [
          agentRecord('%1'),
          agentRecord('%2', { agent_kind: null }),
          agentRecord('%3', { agent_kind: undefined, title: './run.sh' }),
        ],
      ),
    )
    const snap = await discovery.snapshot()
    expect(snap.agents.map((a) => a.id)).toEqual(['%1'])
  })

  test('should not treat kind-less panes as message targets', async () => {
    const discovery = new Discovery(
      cfg,
      fakeTmux([pane('%1', 's'), pane('%2', 's')]),
      fakeWorkmux([worktreeRecord('wt-a')], [agentRecord('%1'), agentRecord('%2', { agent_kind: null })]),
    )
    const targets = await discovery.agentTargets()
    expect(targets.has('%1')).toBe(true)
    expect(targets.has('%2')).toBe(false)
  })
})

describe('GitHub status join', () => {
  test('should serve fixture GitHub statuses keyed by worktree id', async () => {
    const fx: AppConfig = { ...cfg, fixtureDir: fileURLToPath(new URL('../../fixtures', import.meta.url)) }
    const discovery = new Discovery(fx, fakeTmux([]), fakeWorkmux([], []))
    const snap = await discovery.snapshot()
    const byId = new Map(snap.worktrees.map((w) => [w.id, w]))
    const tz = byId.get('wt_b456a632633f')
    expect(tz?.github?.state).toBe('ready')
    expect(tz?.prUrl).toBe('https://github.com/acme/sample-app-alpha/pull/128')
    expect(tz?.github?.ci?.state).toBe('pending')
    // Stale last-good keeps the PR visible but the compatibility prUrl is ready-only.
    const beta = byId.get('wt_c71e94902f0c')
    expect(beta?.github?.state).toBe('stale')
    expect(beta?.github?.pr?.number).toBe(42)
    expect(beta?.prUrl).toBeNull()
    expect(byId.get('wt_44b45f864288')?.github?.state).toBe('unavailable')
    expect(byId.get('wt_107455a78136')?.github?.ci?.state).toBe('none')
  })

  test('should join service status without blocking the snapshot build', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-disc-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: repo })
      writeFileSync(path.join(repo, 'f.txt'), 'x\n')
      execFileSync('git', ['add', 'f.txt'], { cwd: repo })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: repo })
      const gate = Promise.withResolvers<GithubStatus>()
      const svc = new GithubStatusService({ read: () => gate.promise })
      const discovery = new Discovery(cfg, fakeTmux([]), fakeWorkmux([worktreeRecord('wt-a', { path: repo, branch: 'main' })], []), svc)
      // Cycle 1: identity resolution in flight; nothing rendered yet.
      const first = await discovery.snapshot()
      expect(first.worktrees[0]?.github).toBeUndefined()
      // Once identity is cached, the provider call is scheduled non-blocking.
      await vi.waitFor(async () => {
        const snap = await discovery.snapshot(true)
        expect(snap.worktrees[0]?.github?.state).toBe('loading')
      })
      gate.resolve({
        state: 'ready',
        pr: {
          number: 9,
          title: 'T',
          url: 'https://github.com/acme/widgets/pull/9',
          state: 'open',
          review: 'review_required',
          headOid: 'd'.repeat(40),
          headRepository: 'acme/widgets',
          baseRepository: 'acme/widgets',
          baseBranch: 'main',
        },
        ci: null,
        observedAt: Date.now(),
        attemptedAt: Date.now(),
        error: null,
      })
      await vi.waitFor(async () => {
        const snap = await discovery.snapshot(true)
        expect(snap.worktrees[0]?.github?.state).toBe('ready')
      })
      const third = await discovery.snapshot(true)
      expect(third.worktrees[0]?.prUrl).toBe('https://github.com/acme/widgets/pull/9')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('should attach per-remote statuses to worktree views', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-disc3-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { cwd: repo })
      execFileSync('git', ['remote', 'add', 'backup', 'https://gitea.example.com/acme/widgets.git'], { cwd: repo })
      writeFileSync(path.join(repo, 'f.txt'), 'x\n')
      execFileSync('git', ['add', 'f.txt'], { cwd: repo })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: repo })
      const discovery = new Discovery(cfg, fakeTmux([]), fakeWorkmux([worktreeRecord('wt-a', { path: repo, branch: 'main' })], []))
      const snap = await discovery.snapshot(true)
      expect(snap.worktrees[0]?.remotes).toEqual([
        { name: 'origin', url: 'https://github.com/acme/widgets.git', hasRef: false, unpushed: null, behind: null, upstream: false },
        { name: 'backup', url: 'https://gitea.example.com/acme/widgets.git', hasRef: false, unpushed: null, behind: null, upstream: false },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('should mark non-GitHub worktrees unsupported without any provider call', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-disc2-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      execFileSync('git', ['remote', 'add', 'origin', 'https://gitea.example.com/acme/widgets.git'], { cwd: repo })
      writeFileSync(path.join(repo, 'f.txt'), 'x\n')
      execFileSync('git', ['add', 'f.txt'], { cwd: repo })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: repo })
      let reads = 0
      const svc = new GithubStatusService({
        read: async () => {
          reads += 1
          throw new Error('must not be called')
        },
      })
      const discovery = new Discovery(cfg, fakeTmux([]), fakeWorkmux([worktreeRecord('wt-a', { path: repo, branch: 'main' })], []), svc)
      await discovery.snapshot()
      await vi.waitFor(async () => {
        const snap = await discovery.snapshot(true)
        expect(snap.worktrees[0]?.github?.state).toBe('unsupported')
      })
      expect(reads).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
