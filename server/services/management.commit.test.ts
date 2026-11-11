import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { loadConfig } from '../config.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import type { WorktreeView } from '../../shared/types.js'
import { Workmux } from '../adapters/workmux.js'
import { Discovery } from './discovery.js'
import { BadRequestError, Management, TargetNotFoundError } from './management.js'
import { Operations } from './operations.js'
import { TargetLocks } from './target-locks.js'
import { worktreeId } from '../targets.js'

/**
 * Pending-change staging and configurable commit against REAL git, with the
 * commit command pointed at a fake script that records its argv.
 */

let repo: string
let fixtureDir: string
let management: Management
let ops: Operations

const idlePane: TmuxPane = {
  paneId: '%1',
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
}

const idleTmux: TmuxLike = {
  socket: '/tmp/fake',
  ping: async () => true,
  listSessions: async (): Promise<TmuxSession[]> => [],
  listPanes: async () => [idlePane],
  paneExists: async () => true,
  capturePane: async () => '',
  sendLiteral: async () => undefined,
  sendKeys: async () => undefined,
  killPane: async () => undefined,
  createOwnedGroupedSession: async () => undefined,
  selectWindow: async () => undefined,
  killOwnedSession: async () => undefined,
  sessionExists: async () => false,
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

/**
 * Park tracked pending changes, then produce a UU conflict on base.txt
 * (main vs side edits of the same line). Returns the pre-conflict sha.
 */
function beginConflict(): string {
  const initSha = git(['rev-parse', 'HEAD']).trim()
  git(['reset', '-q'])
  git(['stash', '-q']) // tracked edits only; untracked paths stay pending
  writeFileSync(path.join(repo, 'base.txt'), 'base\nMAIN\n')
  git(['add', 'base.txt'])
  git(['commit', '-qm', 'main change'])
  git(['checkout', '-q', '-b', 'side', initSha])
  writeFileSync(path.join(repo, 'base.txt'), 'base\nSIDE\n')
  git(['add', 'base.txt'])
  git(['commit', '-qm', 'side change'])
  git(['checkout', '-q', 'main'])
  spawnSync('git', ['merge', 'side', '-m', 'x'], { cwd: repo, encoding: 'utf8' })
  return initSha
}

/** Abort the merge and restore the exact pre-conflict pending state. */
function endConflict(initSha: string): void {
  spawnSync('git', ['merge', '--abort'], { cwd: repo, encoding: 'utf8' })
  git(['checkout', '-q', 'main'])
  git(['branch', '-q', '-D', 'side'])
  git(['reset', '--hard', initSha])
  git(['stash', 'pop', '-q'])
}

/** Discovery with a directly controllable worktree map (queue-safety tests). */
class FakeDiscovery extends Discovery {
  targets = new Map<string, WorktreeView>()
  /** Resolved synchronously during the first worktreeTargets() call. */
  readonly firstLookup = Promise.withResolvers<void>()
  override async worktreeTargets(): Promise<Map<string, WorktreeView>> {
    this.firstLookup.resolve()
    return this.targets
  }
}

function viewFor(p: string): WorktreeView {
  return {
    id: worktreeId('repo', p),
    project: 'repo',
    projectPath: p,
    handle: 'repo',
    branch: 'main',
    path: p,
    isMain: true,
    mode: 'window',
    hasUncommittedChanges: true,
    isOpen: true,
    agentStatuses: ['waiting'],
    createdAt: 1700000000,
    prUrl: null,
    unpushed: null,
  }
}

async function settle(opId: string): Promise<ReturnType<Operations['get']>> {
  for (let i = 0; i < 50; i++) {
    const op = ops.get(opId)
    if (op && op.state !== 'running') return op
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('operation did not settle')
}

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-commit-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@test.local'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repo, '.gitignore'), 'fake-commit.sh\ncommit-argv.txt\n')
  writeFileSync(path.join(repo, 'base.txt'), 'base\n')
  git(['add', 'base.txt', '.gitignore'])
  git(['commit', '-qm', 'init'])
  writeFileSync(path.join(repo, 'new1.txt'), 'n1\n') // untracked
  writeFileSync(path.join(repo, 'base.txt'), 'base\nmore\n') // unstaged
  writeFileSync(path.join(repo, 'fake-commit.sh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > commit-argv.txt\nexit 0\n')
  chmodSync(path.join(repo, 'fake-commit.sh'), 0o755)

  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-commit-fx-'))
  writeFileSync(
    path.join(fixtureDir, 'list-all.json'),
    JSON.stringify([
      {
        project: 'repo',
        project_path: repo,
        handle: 'repo',
        branch: 'main',
        path: repo,
        is_main: true,
        mode: 'window',
        has_uncommitted_changes: true,
        is_open: true,
        agent_statuses: ['waiting'],
        created_at: 1700000000,
      },
    ]),
  )
  writeFileSync(
    path.join(fixtureDir, 'status-all.json'),
    JSON.stringify({
      context: { backend: 'tmux', instance: '/s' },
      scope: {},
      agents: [
        {
          worktree: 'repo',
          branch: 'main',
          project: 'repo',
          project_path: repo,
          status: 'waiting',
          elapsed_secs: 1,
          title: null,
          pane_id: '%1',
          workdir: repo,
          agent_kind: 'claude',
          session: 's',
          window_name: 'w',
          updated_ts: Math.floor(Date.now() / 1000),
          target_errors: [],
        },
      ],
      target_errors: [],
    }),
  )

  const cfg = {
    ...loadConfig({ WORKMUX_CLAUDE_COMMIT_CMD: './fake-commit.sh' }),
    fixtureDir,
  }
  const discovery = new Discovery(cfg, idleTmux, new Workmux())
  ops = new Operations()
  management = new Management(cfg, idleTmux, new Workmux(), discovery, ops)
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

const wtId = () => worktreeId('repo', repo)

describe('diff carries pending changes', () => {
  test('should include untracked, unstaged, and the resolved commit command', async () => {
    const d = await management.diff(wtId(), 'wip')
    expect(d.untracked).toEqual(['new1.txt'])
    expect(d.unstaged).toEqual(['base.txt'])
    expect(d.conflicts).toEqual([])
    expect(d.commitCmd).toBe('./fake-commit.sh')
  })
})

describe('addPending', () => {
  test('should reject malformed paths without touching git', async () => {
    const r = await management.addPending(wtId(), ['--force', 'new1.txt'])
    expect(r.ok).toBe(false)
    expect(r.offenders).toEqual(['--force'])
  })

  test('should report offenders for paths no longer pending', async () => {
    const r = await management.addPending(wtId(), ['ghost.txt'])
    expect(r.ok).toBe(false)
    expect(r.offenders).toEqual(['ghost.txt'])
  })

  test('should stage untracked and unstaged together', async () => {
    const r = await management.addPending(wtId(), ['new1.txt', 'base.txt'])
    expect(r.ok).toBe(true)
    const d = await management.diff(wtId(), 'wip')
    expect(d.untracked).toEqual([])
    expect(d.unstaged).toEqual([])
    expect(d.hasStaged).toBe(true)
  })

  test('should 404 for unmanaged worktrees', async () => {
    await expect(management.addPending('wt_nope', ['x'])).rejects.toBeInstanceOf(TargetNotFoundError)
  })

  test('should refuse conflicted paths and leave the conflict unresolved in the index', async () => {
    const initSha = beginConflict()
    try {
      expect(git(['status', '--porcelain'])).toMatch(/^UU base\.txt/m)
      const r = await management.addPending(wtId(), ['base.txt'])
      expect(r.ok).toBe(false)
      expect(r.message).toContain('unresolved merge conflicts')
      expect(r.offenders).toEqual(['base.txt'])
      // git add never ran: the path is still a conflict, not recorded resolved
      expect(git(['status', '--porcelain'])).toMatch(/^UU base\.txt/m)
    } finally {
      endConflict(initSha)
    }
  })

  test('should reject a mixed clean+conflicted selection without staging anything', async () => {
    const initSha = beginConflict()
    try {
      const r = await management.addPending(wtId(), ['new1.txt', 'base.txt'])
      expect(r.ok).toBe(false)
      expect(r.message).toContain('unresolved merge conflicts')
      expect(r.offenders).toEqual(['base.txt'])
      const por = git(['status', '--porcelain'])
      expect(por).toContain('?? new1.txt')
      expect(por).toMatch(/^UU base\.txt/m)
    } finally {
      endConflict(initSha)
    }
  })

  test('should revalidate management in-lock and reject when the target vanished while queued', async () => {
    const cfg = { ...loadConfig({}), fixtureDir }
    const disc = new FakeDiscovery(cfg, idleTmux, new Workmux())
    disc.targets.set(wtId(), viewFor(repo))
    const locks = new TargetLocks(ops)
    const mgmt = new Management(cfg, idleTmux, new Workmux(), disc, ops, locks)
    const gate = Promise.withResolvers<void>()
    void locks.run(wtId(), () => gate.promise)
    const p = mgmt.addPending(wtId(), ['new1.txt'])
    // firstLookup resolves inside addPending's pre-lock lookup; that call's
    // continuation (which queues the job behind the gate) was registered
    // first, so the request is provably queued once we resume here.
    await disc.firstLookup.promise
    disc.targets.delete(wtId())
    gate.resolve()
    await expect(p).rejects.toBeInstanceOf(TargetNotFoundError)
    expect(git(['status', '--porcelain'])).toContain('?? new1.txt')
  })
})

describe('commitWorktree', () => {
  test('should run the configured command async with the message appended', async () => {
    const op = await management.commitWorktree(wtId(), 'feat: pending commit')
    expect(op.kind).toBe('commit')
    const done = await settle(op.id)
    expect(done?.state).toBe('done')
    const argv = readFileSync(path.join(repo, 'commit-argv.txt'), 'utf8').trim().split('\n')
    expect(argv).toEqual(['feat: pending commit'])
    expect(git(['log', '--oneline']).split('\n')).toHaveLength(2)
  })

  test('should fail the operation when the command exits nonzero', async () => {
    writeFileSync(path.join(repo, 'base.txt'), 'base\nmore\neven more\n')
    const cfg2 = { ...loadConfig({ WORKMUX_CLAUDE_COMMIT_CMD: 'false' }), fixtureDir }
    const discovery2 = new Discovery(cfg2, idleTmux, new Workmux())
    const mgmt2 = new Management(cfg2, idleTmux, new Workmux(), discovery2, ops)
    const op = await mgmt2.commitWorktree(wtId(), 'will fail')
    const done = await settle(op.id)
    expect(done?.state).toBe('failed')
    expect(done?.error).toMatch(/exit 1/)
  })

  test('should reject when no command is configured for the kind', async () => {
    const cfg2 = { ...loadConfig({}), fixtureDir }
    const discovery2 = new Discovery(cfg2, idleTmux, new Workmux())
    const mgmt2 = new Management(cfg2, idleTmux, new Workmux(), discovery2, new Operations())
    await expect(mgmt2.commitWorktree(wtId(), 'msg')).rejects.toBeInstanceOf(BadRequestError)
  })

  test('should reject commit when the worktree is clean', async () => {
    git(['add', '-A'])
    git(['commit', '-qm', 'make repo clean'])
    await expect(management.commitWorktree(wtId(), 'nothing here')).rejects.toThrow(/nothing_to_commit/)
  })
})

describe('unstagePending', () => {
  test('should reject malformed paths without touching git', async () => {
    const r = await management.unstagePending(wtId(), ['-rf', 'x.txt'])
    expect(r.ok).toBe(false)
    expect(r.offenders).toEqual(['-rf'])
  })

  test('should report offenders for paths that are not staged', async () => {
    git(['reset', '-q']) // everything back to unstaged/untracked
    const r = await management.unstagePending(wtId(), ['new1.txt'])
    expect(r.ok).toBe(false)
    expect(r.message).toContain('not staged')
    expect(r.offenders).toContain('new1.txt')
  })

  test('should stage then restore with content intact and fresh diff both ways', async () => {
    git(['reset', '-q'])
    writeFileSync(path.join(repo, 'new1.txt'), 'n1\nrestored\n') // pending again (modified or untracked)
    expect((await management.addPending(wtId(), ['new1.txt'])).ok).toBe(true)
    expect((await management.diff(wtId(), 'wip')).staged).toContain('new1.txt')
    const r = await management.unstagePending(wtId(), ['new1.txt'])
    expect(r.ok).toBe(true)
    const d = await management.diff(wtId(), 'wip')
    expect(d.staged).not.toContain('new1.txt')
    expect(d.untracked.includes('new1.txt') || d.unstaged.includes('new1.txt')).toBe(true)
    expect(readFileSync(path.join(repo, 'new1.txt'), 'utf8')).toBe('n1\nrestored\n')
  })

  test('should throw TargetNotFoundError for unknown worktrees', async () => {
    await expect(management.unstagePending('wt_000000000000', ['x.txt'])).rejects.toThrow(TargetNotFoundError)
  })
})

describe('commits + commit diff', () => {
  test('should list worktree commits newest-first', async () => {
    const r = await management.commits(wtId(), 50)
    expect(r.commits.length).toBeGreaterThanOrEqual(1)
    expect(r.commits.map((c) => c.subject)).toContain('init') // oldest committed first-run
    expect(r.commits[r.commits.length - 1]?.subject).toBe('init')
    expect(r.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('should throw TargetNotFoundError for unknown worktrees', async () => {
    await expect(management.commits('wt_000000000000', 10)).rejects.toThrow(TargetNotFoundError)
  })

  test('should attach commit metadata in commit-mode diff', async () => {
    const list = await management.commits(wtId(), 5)
    const head = list.commits[0]!
    const d = await management.diff(wtId(), 'commit', head.sha)
    expect(d.mode).toBe('commit')
    expect(d.commit?.subject).toBe(head.subject)
    expect(d.commit?.isMerge).toBe(false)
    expect(d.files.length).toBeGreaterThanOrEqual(1) // init commit adds base.txt
  })

  test('should reject commit-mode diff without sha or with unknown rev', async () => {
    await expect(management.diff(wtId(), 'commit')).rejects.toThrow(BadRequestError)
    await expect(management.diff(wtId(), 'commit', 'definitely-not-a-rev')).rejects.toThrow(BadRequestError)
  })
})
