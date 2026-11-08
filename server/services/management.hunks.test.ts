import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { loadConfig, BOUNDS } from '../config.js'
import type { TmuxLike, TmuxPane, TmuxSession } from '../adapters/tmux.js'
import { Workmux, type StatusPayload } from '../adapters/workmux.js'
import { Discovery } from './discovery.js'
import { Management } from './management.js'
import { Operations } from './operations.js'
import { worktreeId } from '../targets.js'

/**
 * Hunk staging against REAL git: builds a disposable repo with two changes
 * separated by context, then stages/unstages/splits through Management.
 */

let repo: string
let fixtureDir: string
let management: Management
let discovery: Discovery

const FILE_CONTENT = [
  'line one',
  'line two',
  'line three',
  'line four',
  'line five',
  'line six',
  'line seven',
  'line eight',
  'line nine',
].join('\n')

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

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-hunks-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@test.local'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'tag.gpgsign', 'false'])
  writeFileSync(path.join(repo, 'f.txt'), FILE_CONTENT)
  git(['add', 'f.txt'])
  git(['commit', '-qm', 'init'])
  writeFileSync(
    path.join(repo, 'f.txt'),
    FILE_CONTENT.replace('line two', 'line two EDIT-A').replace('line eight', 'line eight EDIT-B'),
  )

  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-fx-'))
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
        },
      ],
      target_errors: [],
    }),
  )

  const cfg = { ...loadConfig({}), fixtureDir }
  discovery = new Discovery(cfg, idleTmux, new Workmux())
  management = new Management(cfg, idleTmux, new Workmux(), discovery, new Operations())
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

const wtId = () => worktreeId('repo', repo)

describe('Management hunk staging (real git)', () => {
  test('should stage a single hunk to the index', async () => {
    const diff = await management.diff(wtId(), 'wip')
    expect(diff.files.length).toBe(1)
    const file = diff.files[0]!
    expect(file.hunks.length).toBe(1)
    expect(file.hunks[0]!.splittable).toBe(true)

    const res = await management.hunkAction(wtId(), 'stage', {
      snapshotId: diff.snapshotId,
      file: file.path,
      hunkIndex: 0,
    })
    expect(res).toMatchObject({ ok: true, snapshotStale: false })
    const staged = git(['diff', '--cached'])
    expect(staged).toContain('EDIT-A')
    expect(staged).toContain('EDIT-B')
  })

  test('should unstage again (undo)', async () => {
    const diff = await management.diff(wtId(), 'wip')
    const res = await management.hunkAction(wtId(), 'unstage', {
      snapshotId: diff.snapshotId,
      file: diff.files[0]!.path,
      hunkIndex: 0,
    })
    expect(res.ok).toBe(true)
    expect(git(['diff', '--cached'])).toBe('')
  })

  test('should split and stage only one piece', async () => {
    const diff = await management.diff(wtId(), 'wip')
    const file = diff.files[0]!
    const split = await management.hunkAction(wtId(), 'split', {
      snapshotId: diff.snapshotId,
      file: file.path,
      hunkIndex: 0,
    })
    expect(split.pieces?.length).toBe(2)

    const staged = await management.hunkAction(wtId(), 'stage', {
      snapshotId: diff.snapshotId,
      file: file.path,
      hunkIndex: 0,
      piece: split.pieces![0],
    })
    expect(staged.ok).toBe(true)
    const cached = git(['diff', '--cached'])
    expect(cached).toContain('EDIT-A')
    expect(cached).not.toContain('EDIT-B')
    git(['reset', '-q'])
  })

  test('should reject stale snapshots without touching the index', async () => {
    const diff = await management.diff(wtId(), 'wip')
    writeFileSync(path.join(repo, 'f.txt'), FILE_CONTENT.replace('line five', 'line five AGENT-EDIT'))
    const res = await management.hunkAction(wtId(), 'stage', {
      snapshotId: diff.snapshotId,
      file: diff.files[0]!.path,
      hunkIndex: 0,
    })
    expect(res).toMatchObject({ ok: false, snapshotStale: true })
    expect(git(['diff', '--cached'])).toBe('')
    writeFileSync(path.join(repo, 'f.txt'), FILE_CONTENT.replace('line two', 'line two EDIT-A').replace('line eight', 'line eight EDIT-B'))
  })

  test('should reject foreign patch text as piece', async () => {
    const diff = await management.diff(wtId(), 'wip')
    const res = await management.hunkAction(wtId(), 'stage', {
      snapshotId: diff.snapshotId,
      file: diff.files[0]!.path,
      hunkIndex: 0,
      piece: '@@ -1,1 +1,1 @@\n-INJECTED\n+EVIL',
    })
    expect(res.ok).toBe(false)
  })

  test('should report unborn repositories explicitly', async () => {
    git(['rm', '-r', '--cached', '-q', '.'])
    git(['commit', '-q', '--allow-empty', '-m', 'wipe'])
    git(['update-ref', '-d', 'HEAD'])
    const fresh = { ...loadConfig({}), fixtureDir }
    const d2 = new Discovery(fresh, idleTmux, new Workmux())
    const m2 = new Management(fresh, idleTmux, new Workmux(), d2, new Operations())
    const diff = await m2.diff(wtId(), 'wip')
    expect(diff.unborn).toBe(true)
    expect(diff.baseMissing).toBe(false)
    const branch = await m2.diff(wtId(), 'branch')
    expect(branch.baseMissing).toBe(true)
  })
})

describe('confirmation token lifecycle', () => {
  test('should reject a second execute of the same token', async () => {
    const prepared = await management.prepare({ action: 'stop', targetId: '%1' })
    const token = prepared.confirmToken!
    await expect(
      management.execute({ action: 'stop', targetId: '%1', confirmToken: token, requestId: 'ex-1' }),
    ).resolves.toBeTruthy()
    await expect(
      management.execute({ action: 'stop', targetId: '%1', confirmToken: token, requestId: 'ex-2' }),
    ).rejects.toThrow(/expired or invalid/)
  })

  test('should let exactly one of two concurrent executes through', async () => {
    const prepared = await management.prepare({ action: 'stop', targetId: '%1' })
    const token = prepared.confirmToken!
    const results = await Promise.allSettled([
      management.execute({ action: 'stop', targetId: '%1', confirmToken: token, requestId: 'ex-3' }),
      management.execute({ action: 'stop', targetId: '%1', confirmToken: token, requestId: 'ex-4' }),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled').length
    expect(ok).toBe(1)
  })

  test('should reject execute once the token TTL elapsed even without a later prepare (F08)', async () => {
    const prepared = await management.prepare({ action: 'stop', targetId: '%1' })
    const token = prepared.confirmToken!
    const realNow = Date.now
    try {
      Date.now = () => realNow() + BOUNDS.confirmTokenTtlMs + 1
      await expect(
        management.execute({ action: 'stop', targetId: '%1', confirmToken: token, requestId: 'ex-5' }),
      ).rejects.toThrow(/confirmation expired/)
    } finally {
      Date.now = realNow
    }
  })

  test('should serialize executes for one target until the first operation settles (F03)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const kills: string[] = []
    const gatedTmux: TmuxLike = {
      ...idleTmux,
      killPane: async (id: string) => {
        kills.push(id)
        await gate
      },
    }
    const cfg = { ...loadConfig({}), fixtureDir }
    const gated = new Management(cfg, gatedTmux, new Workmux(), new Discovery(cfg, gatedTmux, new Workmux()), new Operations())
    const p1 = await gated.prepare({ action: 'stop', targetId: '%1' })
    const p2 = await gated.prepare({ action: 'stop', targetId: '%1' })

    const e1 = gated.execute({ action: 'stop', targetId: '%1', confirmToken: p1.confirmToken!, requestId: 'f1' })
    expect((await e1).state).toBe('running')
    await new Promise((r) => setTimeout(r, 10))

    let secondResolved = false
    const e2 = gated
      .execute({ action: 'stop', targetId: '%1', confirmToken: p2.confirmToken!, requestId: 'f2' })
      .then((v) => {
        secondResolved = true
        return v
      })
    await new Promise((r) => setTimeout(r, 25))
    // Second action must stay queued while the first op is still running.
    expect(secondResolved).toBe(false)
    expect(kills).toEqual(['%1'])

    release()
    await Promise.all([e1, e2])
    expect(kills).toEqual(['%1', '%1'])
    expect(secondResolved).toBe(true)
  })
})
