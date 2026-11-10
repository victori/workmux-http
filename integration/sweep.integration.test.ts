import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../server/exec.js'
import { Workmux } from '../server/adapters/workmux.js'
import { SweepGit } from '../server/adapters/sweep-git.js'
import type { WorktreeView } from '../shared/types.js'

/**
 * Native removal semantics against the REAL workmux CLI (installed v0.1.281
 * is the compatibility baseline) on a dedicated tmux socket (`wmhttp-sweep-it`)
 * and disposable repositories only. Fake argv assertions are not a native
 * deletion proof; this file is. Skips with a reason when tmux/workmux are
 * absent. Never touches user sessions or real remotes.
 */

const tmuxAvailable = await run(['tmux', '-V']).then((r) => r.code === 0).catch(() => false)
const workmuxAvailable = await run(['workmux', '--help']).then((r) => r.code === 0).catch(() => false)
const SKIP = !tmuxAvailable || !workmuxAvailable
const skipReason = `requires tmux (${tmuxAvailable}) and workmux (${workmuxAvailable})`

const SOCKET = tmuxAvailable
  ? await run(['tmux', 'display-message', '-p', '#{socket_path}'])
      .then((r) => `${r.stdout.trim().replace(/\/[^/]+$/, '')}/wmhttp-sweep-it`)
      .catch(() => '/tmp/wmhttp-sweep-it')
  : '/tmp/wmhttp-sweep-it'

let sandbox: string
let main: string
let wm: Workmux
const sweepGit = new SweepGit()

function view(overrides: Partial<WorktreeView> = {}): WorktreeView {
  return {
    id: 'wt_itest',
    project: 'itrepo',
    projectPath: main,
    handle: 'wt-x',
    branch: 'feat/x',
    path: path.join(main, '.worktrees', 'wt-x'),
    isMain: false,
    mode: 'window',
    hasUncommittedChanges: false,
    isOpen: true,
    agentStatuses: [],
    createdAt: 0,
    prUrl: null,
    unpushed: null,
    ...overrides,
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await run(['git', ...args], { cwd })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.trim()}`)
  return res.stdout.trim()
}

// workmux places worktrees under a layout that varies by version/config
// (e.g. `<repo>/.worktrees/<name>` in 0.1.281). Capture the real path from
// `workmux add` output instead of hardcoding the convention.
const wtPaths = new Map<string, string>()

async function addWorktree(name: string, branch: string): Promise<void> {
  const res = await wm.add({ cwd: main, branch, name })
  if (res.code !== 0) throw new Error(`workmux add failed: ${res.stderr.trim()}`)
  const m = /^\s*Worktree:\s*(.+?)\s*$/m.exec(res.stdout)
  const p = m?.[1]
  if (p !== undefined) wtPaths.set(name, p)
}

function wtDir(name: string): string {
  const p = wtPaths.get(name)
  if (!p) throw new Error(`worktree path unknown for ${name}; call addWorktree first`)
  return p
}

beforeAll(async () => {
  if (SKIP) return
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
  process.env.GIT_CONFIG_VALUE_0 = 'false'
  process.env.TMUX = `${SOCKET},1,1`
  await run(['tmux', '-S', SOCKET, 'kill-server'])
  await run(['tmux', '-S', SOCKET, 'new-session', '-d', '-s', 'itest', '-x', '120', '-y', '30'])
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-sweep-it-'))
  const remote = path.join(sandbox, 'remote.git')
  main = path.join(sandbox, 'main')
  await git(sandbox, ['init', '--bare', '-b', 'main', remote]).catch(() => undefined)
  await run(['git', 'clone', remote, main]).then((r) => {
    if (r.code !== 0) throw new Error(r.stderr)
  })
  await git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'init'])
  await git(main, ['push', '-u', 'origin', 'main'])
  await git(main, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  wm = new Workmux()
})

afterAll(async () => {
  delete process.env.TMUX
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  if (tmuxAvailable) await run(['tmux', '-S', SOCKET, 'kill-server'])
})

describe.skipIf(SKIP)(
  `native sweep removal (real workmux + tmux socket wmhttp-sweep-it)${SKIP ? ` — SKIPPED: ${skipReason}` : ''}`,
  () => {
  test('should remove cleanly and retain the branch with --keep-branch', async () => {
    await addWorktree('wt-keep', 'feat/keep')
    expect(existsSync(wtDir('wt-keep'))).toBe(true)
    const res = await wm.remove({ cwd: wtDir('wt-keep'), name: 'wt-keep', keepBranch: true })
    expect(res.code).toBe(0)
    expect(existsSync(wtDir('wt-keep'))).toBe(false)
    const branch = await git(main, ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/keep'])
    expect(branch).toMatch(/^[0-9a-f]{40}$/)
    const confirmed = await sweepGit.removed(
      view({ handle: 'wt-keep', branch: 'feat/keep', path: wtDir('wt-keep') }),
      true,
    )
    expect(confirmed).toBe(true)
  })

  test('should refuse natively on a dirty worktree without force', async () => {
    await addWorktree('wt-dirty', 'feat/dirty')
    writeFileSync(path.join(wtDir('wt-dirty'), 'scratch.txt'), 'keep me\n')
    const refused = await wm.remove({ cwd: wtDir('wt-dirty'), name: 'wt-dirty', keepBranch: true })
    expect(refused.code).not.toBe(0)
    expect(refused.stderr + refused.stdout).toContain('uncommitted')
    expect(existsSync(wtDir('wt-dirty'))).toBe(true)
    // Facts agree the worktree is not sweepable.
    const facts = await sweepGit.inspect(view({ handle: 'wt-dirty', branch: 'feat/dirty', path: wtDir('wt-dirty') }))
    expect(facts.untracked).toBe(true)
  })

  test('should delete the branch when keep-branch is not requested', async () => {
    await addWorktree('wt-np', 'feat/np')
    const res = await wm.remove({ cwd: wtDir('wt-np'), name: 'wt-np' })
    expect(res.code).toBe(0)
    expect(existsSync(wtDir('wt-np'))).toBe(false)
    const gone = await sweepGit.removed(view({ handle: 'wt-np', branch: 'feat/np', path: wtDir('wt-np') }), false)
    expect(gone).toBe(true)
  })
  },
)
