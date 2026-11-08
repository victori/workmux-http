import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../config.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import { Workmux } from '../adapters/workmux.js'
import { Discovery } from './discovery.js'
import { BadRequestError, ConfirmationError, Management } from './management.js'
import { Operations } from './operations.js'
import { worktreeId } from '../targets.js'

/**
 * Push action against REAL git with a local bare remote. The remote is a
 * temp dir — verification never touches real remotes.
 */

let remote: string
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
function rgit(args: string[]): string {
  return execFileSync('git', args, { cwd: remote, encoding: 'utf8' })
}

function commit(file: string, message: string): void {
  writeFileSync(path.join(repo, file), `${message}\n`)
  git(['add', file])
  git(['commit', '-qm', message])
}

async function settle(opId: string): Promise<ReturnType<Operations['get']>> {
  for (let i = 0; i < 100; i++) {
    const op = ops.get(opId)
    if (op && op.state !== 'running') return op
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('operation did not settle')
}

beforeAll(() => {
  remote = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-push-remote-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-push-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo })
  git(['remote', 'add', 'origin', remote])
  commit('a.txt', 'feat: one')
  commit('b.txt', 'fix: two')

  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-push-fx-'))
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
        has_uncommitted_changes: false,
        is_open: true,
        agent_statuses: ['waiting'],
        created_at: 1700000000,
      },
    ]),
  )
  writeFileSync(path.join(fixtureDir, 'status-all.json'), JSON.stringify({ agents: [], target_errors: [] }))

  const cfg = { ...loadConfig({}), fixtureDir }
  const discovery = new Discovery(cfg, idleTmux, new Workmux())
  ops = new Operations()
  management = new Management(cfg, idleTmux, new Workmux(), discovery, ops)
})

afterAll(() => {
  rmSync(remote, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
  rmSync(fixtureDir, { recursive: true, force: true })
})

const wtId = () => worktreeId('repo', repo)

describe('push action (real git + bare remote)', () => {
  test('should list unpushed commits and warn about first push', async () => {
    const p = await management.prepare({ action: 'push', targetId: wtId() })
    expect(p.commits?.map((c) => c.subject)).toEqual(['fix: two', 'feat: one'])
    expect(p.warnings.join(' ')).toMatch(/creates origin\/main/)
    expect(p.blocked).toBeUndefined()
    expect(p.confirmToken).toBeTruthy()
  })

  test('should first-push with -u after accepting the warning', async () => {
    const p = await management.prepare({ action: 'push', targetId: wtId() })
    const op = await management.execute({
      action: 'push',
      targetId: wtId(),
      confirmToken: p.confirmToken!,
      requestId: 'r1',
      acceptWarnings: true,
    })
    const done = await settle(op.id)
    expect(done?.state).toBe('done')
    expect(rgit(['rev-parse', 'main']).trim()).toBe(git(['rev-parse', 'HEAD']).trim())
    expect(git(['rev-parse', '--abbrev-ref', '@{u}']).trim()).toBe('origin/main')
  })

  test('should block when nothing is to push', async () => {
    const p = await management.prepare({ action: 'push', targetId: wtId() })
    expect(p.blocked).toMatch(/nothing to push/)
  })

  test('should reject execute when HEAD moved after prepare', async () => {
    const p = await management.prepare({ action: 'push', targetId: wtId() })
    commit('c.txt', 'feat: late') // drift between prepare and execute
    await expect(
      management.execute({
        action: 'push',
        targetId: wtId(),
        confirmToken: p.confirmToken!,
        requestId: 'r2',
        acceptWarnings: true,
      }),
    ).rejects.toThrow(ConfirmationError)
  })

  test('should push the drifted state after re-confirmation', async () => {
    const p = await management.prepare({ action: 'push', targetId: wtId() })
    expect(p.commits?.map((c) => c.subject)).toEqual(['feat: late'])
    const op = await management.execute({
      action: 'push',
      targetId: wtId(),
      confirmToken: p.confirmToken!,
      requestId: 'r3',
      acceptWarnings: p.warnings.length > 0,
    })
    expect((await settle(op.id))?.state).toBe('done')
  })

  test('should warn on divergence and refuse unacknowledged execute', async () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-push-other-'))
    execFileSync('git', ['clone', '-q', remote, other])
    execFileSync('git', ['config', 'user.email', 'o@o.local'], { cwd: other })
    execFileSync('git', ['config', 'user.name', 'O'], { cwd: other })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: other })
    writeFileSync(path.join(other, 'r.txt'), 'remote\n')
    execFileSync('git', ['add', 'r.txt'], { cwd: other })
    execFileSync('git', ['commit', '-qm', 'remote commit'], { cwd: other })
    execFileSync('git', ['push', '-q'], { cwd: other })
    commit('local.txt', 'local divergent')
    git(['fetch', '-q', 'origin'])

    const p = await management.prepare({ action: 'push', targetId: wtId() })
    expect(p.warnings.join(' ')).toMatch(/newer commit\(s\)/)
    await expect(
      management.execute({
        action: 'push',
        targetId: wtId(),
        confirmToken: p.confirmToken!,
        requestId: 'r4',
      }),
    ).rejects.toThrow(/unacknowledged warnings/)
    rmSync(other, { recursive: true, force: true })
  })

  test('should block when no origin remote exists', async () => {
    const orphan = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-push-orphan-'))
    execFileSync('git', ['init', '-q', '-b', 'main', orphan])
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: orphan })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: orphan })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: orphan })
    writeFileSync(path.join(orphan, 'x.txt'), 'x\n')
    execFileSync('git', ['add', 'x.txt'], { cwd: orphan })
    execFileSync('git', ['commit', '-qm', 'only local'], { cwd: orphan })

    const fx2 = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-push-fx2-'))
    writeFileSync(
      path.join(fx2, 'list-all.json'),
      JSON.stringify([
        {
          project: 'orphan',
          project_path: orphan,
          handle: 'orphan',
          branch: 'main',
          path: orphan,
          is_main: true,
          mode: 'window',
          has_uncommitted_changes: false,
          is_open: true,
          agent_statuses: [],
          created_at: 1700000000,
        },
      ]),
    )
    writeFileSync(path.join(fx2, 'status-all.json'), JSON.stringify({ agents: [], target_errors: [] }))
    const cfg2 = { ...loadConfig({}), fixtureDir: fx2 }
    const disc2 = new Discovery(cfg2, idleTmux, new Workmux())
    const mgmt2 = new Management(cfg2, idleTmux, new Workmux(), disc2, new Operations())

    const p = await mgmt2.prepare({ action: 'push', targetId: worktreeId('orphan', orphan) })
    expect(p.blocked).toMatch(/no origin remote/)
    rmSync(orphan, { recursive: true, force: true })
    rmSync(fx2, { recursive: true, force: true })
  })
})
