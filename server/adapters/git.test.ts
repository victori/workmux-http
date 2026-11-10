import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { addPaths, commitDiff, commitInfo, commitList, hasOrigin, push, repoStatus, resolveGithubRequest, runCommit, unstagePaths, unpushedCommits } from './git.js'

/**
 * Real-git checks for status parsing, path staging, and the commit runner,
 * on a disposable repo.
 */

let repo: string

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-git-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@test.local'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'a\nb\nc\n')
  git(['add', 'tracked.txt'])
  git(['commit', '-qm', 'init'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'a\nB\nc\n') // unstaged
  writeFileSync(path.join(repo, 'staged-then-edited.txt'), 'one\n')
  git(['add', 'staged-then-edited.txt'])
  writeFileSync(path.join(repo, 'staged-then-edited.txt'), 'one\ntwo\n') // MM
  writeFileSync(path.join(repo, 'new-file.txt'), 'fresh\n') // untracked
})

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
})

describe('repoStatus', () => {
  test('should classify untracked, unstaged, and staged-then-edited files', async () => {
    const s = await repoStatus(repo)
    expect(s.untracked).toEqual(['new-file.txt'])
    expect(s.unstaged).toContain('tracked.txt')
    expect(s.unstaged).toContain('staged-then-edited.txt') // MM: both lists
    expect(s.hasStaged).toBe(true)
    expect(s.hasUnstaged).toBe(true)
    expect(s.conflicts).toEqual([])
    expect(s.branch).toBe('main')
    expect(s.pendingChanges).toBe(3) // M + MM(counts once) + ??
  })

  test('should report nothing pending on a clean repo', async () => {
    git(['add', '-A'])
    git(['commit', '-qm', 'second'])
    const s = await repoStatus(repo)
    expect(s.untracked).toEqual([])
    expect(s.unstaged).toEqual([])
    expect(s.conflicts).toEqual([])
    expect(s.hasStaged).toBe(false)
    expect(s.hasUnstaged).toBe(false)
    expect(s.pendingChanges).toBe(0)
  })

  test('should list unmerged paths as conflicts', async () => {
    git(['checkout', '-qb', 'conflict-side'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'a\nX\nc\n')
    git(['commit', '-qam', 'side change'])
    git(['checkout', '-q', 'main'])
    writeFileSync(path.join(repo, 'tracked.txt'), 'a\nZ\nc\n')
    git(['commit', '-qam', 'main change'])
    try {
      git(['merge', 'conflict-side', '-m', 'merge'])
    } catch {
      /* expected: merge reports conflict with exit code 1 */
    }
    const s = await repoStatus(repo)
    expect(s.conflicts).toEqual(['tracked.txt'])
    // cleanup back to a working main
    git(['merge', '--abort'])
    git(['reset', '-q', '--hard', 'HEAD~1'])
    git(['branch', '-D', 'conflict-side'])
  })
})

describe('addPaths', () => {
  test('should stage untracked and unstaged paths exactly as requested', async () => {
    // fresh scenario independent of earlier tests' commits
    writeFileSync(path.join(repo, 'p-untracked.txt'), 'fresh\n')
    writeFileSync(path.join(repo, 'p-staged.txt'), 'one\n')
    git(['add', 'p-staged.txt'])
    writeFileSync(path.join(repo, 'p-staged.txt'), 'one\ntwo\n') // MM
    writeFileSync(path.join(repo, 'p-unstaged.txt'), 'keep\n')
    git(['add', 'p-unstaged.txt'])
    git(['commit', '-qm', 'baseline-p'])
    writeFileSync(path.join(repo, 'p-unstaged.txt'), 'keep\nchanged\n')

    await addPaths(repo, ['p-untracked.txt', 'p-unstaged.txt'])
    const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
    expect(staged).toContain('p-untracked.txt')
    expect(staged).toContain('p-unstaged.txt')
    expect(staged).not.toContain('p-staged.txt') // untouched MM file stays out
    const s = await repoStatus(repo)
    expect(s.untracked).toEqual([])
    expect(s.unstaged).toEqual(['p-staged.txt'])
    expect(s.hasStaged).toBe(true)
  })
})

describe('runCommit', () => {
  test('should execute argv with the message as one element', async () => {
    const script = path.join(repo, 'fake-commit.sh')
    writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$@" > argv.txt\nexit 0\n')
    chmodSync(script, 0o755)
    const r = await runCommit(repo, ['./fake-commit.sh', '-m', 'feat: hello world'], 15000)
    expect(r.code).toBe(0)
    expect(readFileSync(path.join(repo, 'argv.txt'), 'utf8').trim().split('\n')).toEqual([
      '-m',
      'feat: hello world',
    ])
  })

  test('should report failing commands via exit code, not throw', async () => {
    const r = await runCommit(repo, ['git', 'commit', '-m', 'nothing staged to commit check'], 15000)
    // repo has staged content from the addPaths test; use a no-op failure instead
    const r2 = await runCommit(repo, ['false'], 15000)
    expect(r2.code).not.toBe(0)
    void r
  })

  test('should kill commands exceeding the timeout with code 124', async () => {
    const r = await runCommit(repo, ['sleep', '5'], 300)
    expect(r.code).toBe(124)
  })

  test('should reject when the binary does not exist', async () => {
    await expect(runCommit(repo, ['definitely-not-a-real-binary', 'msg'], 5000)).rejects.toBeTruthy()
  })
})

describe('push path (real git + local bare remote)', () => {
  let remote: string
  let clone: string

  function cgit(args: string[]): string {
    return execFileSync('git', args, { cwd: clone, encoding: 'utf8' })
  }
  function rgit(args: string[]): string {
    return execFileSync('git', args, { cwd: remote, encoding: 'utf8' })
  }

  beforeAll(() => {
    remote = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-remote-'))
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    clone = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-clone-'))
    execFileSync('git', ['clone', '-q', remote, clone])
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: clone })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: clone })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: clone })
    writeFileSync(path.join(clone, 'f.txt'), '1\n')
    execFileSync('git', ['add', 'f.txt'], { cwd: clone })
    execFileSync('git', ['commit', '-qm', 'feat: first'], { cwd: clone })
  })

  afterAll(() => {
    rmSync(remote, { recursive: true, force: true })
    rmSync(clone, { recursive: true, force: true })
  })

  test('should report no upstream before first push and detect origin', async () => {
    const s = await repoStatus(clone)
    expect(s.hasUpstream).toBe(false)
    expect(await hasOrigin(clone)).toBe(true)
    const u = await unpushedCommits(clone, 'main', 20)
    expect(u.ref).toBeNull()
    expect(u.commits.map((c) => c.subject)).toEqual(['feat: first'])
  })

  test('should first-push with -u, then report ahead/behind and range', async () => {
    const p = await push(clone, 'main', true, 30_000)
    expect(p.code).toBe(0)
    expect(rgit(['rev-parse', 'main']).trim()).toBe(cgit(['rev-parse', 'HEAD']).trim())

    writeFileSync(path.join(clone, 'f.txt'), '1\n2\n')
    cgit(['add', 'f.txt'])
    cgit(['commit', '-qm', 'feat: second'])
    writeFileSync(path.join(clone, 'g.txt'), 'x\n')
    cgit(['add', 'g.txt'])
    cgit(['commit', '-qm', 'fix: third'])

    const s = await repoStatus(clone)
    expect(s.hasUpstream).toBe(true)
    expect(s.ahead).toBe(2)
    expect(s.behind).toBe(0)

    const u = await unpushedCommits(clone, 'main', 20)
    expect(u.ref).toBe('origin/main')
    expect(u.commits.map((c) => c.subject)).toEqual(['fix: third', 'feat: second'])
    expect(u.commits.every((c) => c.body === '')).toBe(true)
    expect(u.truncated).toBe(false)

    const p2 = await push(clone, 'main', false, 30_000)
    expect(p2.code).toBe(0)
    expect((await repoStatus(clone)).ahead).toBe(0)
  })

  test('should cap the commit list and flag truncation', async () => {
    writeFileSync(path.join(clone, 'cap.txt'), 'c\n')
    cgit(['add', 'cap.txt'])
    cgit(['commit', '-qm', 'chore: cap'])
    writeFileSync(path.join(clone, 'cap2.txt'), 'c2\n')
    cgit(['add', 'cap2.txt'])
    cgit(['commit', '-qm', 'chore: cap2'])
    const u = await unpushedCommits(clone, 'main', 1)
    expect(u.commits).toHaveLength(1)
    expect(u.truncated).toBe(true)
  })

  test('should reject non-fast-forward without ever forcing', async () => {
    // Remote moves ahead via a second clone.
    const other = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-other-'))
    execFileSync('git', ['clone', '-q', remote, other])
    execFileSync('git', ['config', 'user.email', 'o@o.local'], { cwd: other })
    execFileSync('git', ['config', 'user.name', 'O'], { cwd: other })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: other })
    writeFileSync(path.join(other, 'h.txt'), 'remote\n')
    execFileSync('git', ['add', 'h.txt'], { cwd: other })
    execFileSync('git', ['commit', '-qm', 'remote commit'], { cwd: other })
    execFileSync('git', ['push', '-q'], { cwd: other })

    writeFileSync(path.join(clone, 'local.txt'), 'diverged\n')
    cgit(['add', 'local.txt'])
    cgit(['commit', '-qm', 'local divergent'])
    cgit(['fetch', '-q', 'origin'])

    const s = await repoStatus(clone)
    expect(s.ahead).toBe(3) // cap, cap2, local divergent
    expect(s.behind).toBeGreaterThan(0)

    const p = await push(clone, 'main', false, 30_000)
    expect(p.code).not.toBe(0)
    expect(`${p.stdout}${p.stderr}`).toMatch(/non-fast-forward|fetch first|rejected/i)
    rmSync(other, { recursive: true, force: true })
  })

  test('should capture multi-line commit bodies', async () => {
    writeFileSync(path.join(clone, 'body.txt'), 'b\n')
    cgit(['add', 'body.txt'])
    cgit(['commit', '-qm', 'feat: with body', '-m', 'line one', '-m', 'line two'])
    const u = await unpushedCommits(clone, 'main', 20)
    expect(u.commits[0]?.subject).toBe('feat: with body')
    expect(u.commits[0]?.body).toBe('line one\n\nline two')
  })
})

describe('repoStatus filename fidelity (audit F10)', () => {
  test('should return raw unicode/quote/space paths and stage them back exactly', async () => {
    const nasty = ['café.txt', 'sp ace.txt', 'qu"ote.txt', 'back\\slash.txt', 'tab\tname.txt', 'new\nline.txt', "apo's.txt"]
    for (const name of nasty) writeFileSync(path.join(repo, name), 'nasty\n')
    try {
      const s = await repoStatus(repo)
      for (const name of nasty) expect(s.untracked).toContain(name)
      await addPaths(repo, nasty) // throws unless every pathspec matched
      const staged = git(['diff', '--cached', '--name-only', '-z']).split('\0')
      for (const name of nasty) expect(staged).toContain(name)
      // Unstage again so later tests see a stable tree.
      git(['reset', '-q'])
    } finally {
      for (const name of nasty) rmSync(path.join(repo, name), { force: true })
    }
  })

  test('should keep rename destination and count the rename once', async () => {
    writeFileSync(path.join(repo, 'orig-name.txt'), 'r\n')
    git(['add', 'orig-name.txt'])
    git(['commit', '-qm', 'add orig'])
    const before = await repoStatus(repo)
    git(['mv', 'orig-name.txt', 'renamed-dest.txt'])
    try {
      const s = await repoStatus(repo)
      expect(s.hasStaged).toBe(true)
      // Repo carries other pending entries from earlier tests; the staged
      // rename ('2' record + source record) must add exactly ONE path entry.
      expect(s.pendingChanges - before.pendingChanges).toBe(1)
      expect(git(['diff', '--cached', '--name-status']).trim()).toMatch(/^R\d+\torig-name.txt\trenamed-dest.txt$/m)
      git(['reset', '-q', '--soft', 'HEAD~1'])
      git(['reset', '-q'])
      rmSync(path.join(repo, 'orig-name.txt'), { force: true })
    } finally {
      rmSync(path.join(repo, 'renamed-dest.txt'), { force: true })
    }
  })
})

describe('staged paths and unstage round-trip', () => {
  let sub: string
  const gitSub = (args: string[]): string => execFileSync('git', args, { cwd: sub, encoding: 'utf8' })

  beforeAll(() => {
    sub = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-unstage-'))
    gitSub(['init', '-q', '-b', 'main'])
    gitSub(['config', 'user.email', 'test@test.local'])
    gitSub(['config', 'user.name', 'Test'])
    gitSub(['config', 'commit.gpgsign', 'false'])
    writeFileSync(path.join(sub, 'base.txt'), 'x\n')
    gitSub(['add', 'base.txt'])
    gitSub(['commit', '-qm', 'init'])
    writeFileSync(path.join(sub, 'café.txt'), 'unicode\n')
    writeFileSync(path.join(sub, 'pure-staged.txt'), 'staged only\n')
    gitSub(['add', 'pure-staged.txt', 'café.txt'])
    writeFileSync(path.join(sub, 'mm.txt'), 'one\n')
    gitSub(['add', 'mm.txt'])
    writeFileSync(path.join(sub, 'mm.txt'), 'one\ntwo\n') // MM
  })

  afterAll(() => {
    if (sub) rmSync(sub, { recursive: true, force: true })
  })

  test('should list staged paths including pure-staged, MM, and unicode names', async () => {
    const s = await repoStatus(sub)
    expect(s.staged).toEqual(expect.arrayContaining(['pure-staged.txt', 'café.txt', 'mm.txt']))
    expect(s.untracked).toEqual([])
    expect(s.unstaged).toEqual(['mm.txt']) // MM: staged AND unstaged
  })

  test('should return a previously added file to untracked with content intact', async () => {
    await unstagePaths(sub, ['café.txt'])
    const s = await repoStatus(sub)
    expect(s.staged).not.toContain('café.txt')
    expect(s.untracked).toContain('café.txt')
    expect(readFileSync(path.join(sub, 'café.txt'), 'utf8')).toBe('unicode\n')
  })

  test('should drop only the index side of an added-then-edited file on unstage', async () => {
    await unstagePaths(sub, ['mm.txt'])
    const s = await repoStatus(sub)
    expect(s.staged).not.toContain('mm.txt')
    // mm.txt is not in HEAD, so unstage falls back to untracked — content kept
    expect(s.untracked).toContain('mm.txt')
    expect(readFileSync(path.join(sub, 'mm.txt'), 'utf8')).toBe('one\ntwo\n')
  })
})

describe('commit history', () => {
  let hist: string
  const gitH = (args: string[]): string => execFileSync('git', args, { cwd: hist, encoding: 'utf8' })
  let mergeSha = ''
  let rootSha = ''

  beforeAll(() => {
    hist = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-hist-'))
    gitH(['init', '-q', '-b', 'main'])
    gitH(['config', 'user.email', 'test@test.local'])
    gitH(['config', 'user.name', 'Test'])
    gitH(['config', 'commit.gpgsign', 'false'])
    writeFileSync(path.join(hist, 'a.txt'), 'a\n')
    gitH(['add', 'a.txt'])
    gitH(['commit', '-qm', 'root commit'])
    rootSha = gitH(['rev-parse', 'HEAD']).trim()
    writeFileSync(path.join(hist, 'b.txt'), 'b\n')
    gitH(['add', 'b.txt'])
    gitH(['commit', '-qm', 'café ☕ subject with unicode'])
    gitH(['checkout', '-q', '-b', 'side'])
    writeFileSync(path.join(hist, 'c.txt'), 'c\n')
    gitH(['add', 'c.txt'])
    gitH(['commit', '-qm', 'side change'])
    gitH(['checkout', '-q', 'main'])
    gitH(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])
    mergeSha = gitH(['rev-parse', 'HEAD']).trim()
  })

  afterAll(() => {
    if (hist) rmSync(hist, { recursive: true, force: true })
  })

  test('should list commits newest-first with unicode subjects and merge flag', async () => {
    const r = await commitList(hist, 10)
    expect(r.truncated).toBe(false)
    expect(r.commits[0]).toMatchObject({ sha: mergeSha, subject: 'merge side', isMerge: true })
    expect(r.commits[1]?.subject).toBe('café ☕ subject with unicode') // main parent first
    expect(r.commits.map((c) => c.isMerge)).toEqual([true, false, false, false])
    expect(r.commits[2]?.subject).toBe('side change')
    expect(r.commits[3]?.sha).toBe(rootSha)
  })

  test('should truncate at limit and report truncated', async () => {
    const r = await commitList(hist, 2)
    expect(r.commits).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })

  test('should return empty list for unborn repo', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-unborn-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: empty })
      expect(await commitList(empty, 10)).toEqual({ commits: [], truncated: false })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('should diff a commit against its first parent', async () => {
    const d = await commitDiff(hist, mergeSha)
    expect(d.files.map((f) => f.path)).toEqual(['c.txt']) // parent-1 sees only side's change
  })

  test('should diff root commit against the empty tree', async () => {
    const d = await commitDiff(hist, rootSha)
    expect(d.files.map((f) => f.path)).toEqual(['a.txt'])
    expect(d.files[0]?.status).toBe('added')
  })

  test('should reject unsafe revisions', async () => {
    await expect(commitDiff(hist, 'main..side')).rejects.toThrow(/unsafe/)
    await expect(commitDiff(hist, '--output=x')).rejects.toThrow(/unsafe/)
    expect(await commitInfo(hist, 'no-such-rev-xyz')).toBeNull()
  })

  test('should resolve commit metadata by short sha', async () => {
    const info = await commitInfo(hist, mergeSha.slice(0, 8))
    expect(info).toMatchObject({ sha: mergeSha, subject: 'merge side', isMerge: true, author: 'Test' })
  })
})

describe('unpushed fallback without configured upstream', () => {
  let originDir: string
  let cloneDir: string
  const gitO = (args: string[]): string => execFileSync('git', args, { cwd: originDir, encoding: 'utf8' })
  const gitC = (args: string[]): string => execFileSync('git', args, { cwd: cloneDir, encoding: 'utf8' })

  beforeAll(() => {
    originDir = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-origin-'))
    cloneDir = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-clone-'))
    gitO(['init', '-q', '--bare', '--initial-branch=main', originDir])
    execFileSync('git', ['clone', '-q', originDir, cloneDir])
    gitC(['config', 'user.email', 't@t.local'])
    gitC(['config', 'user.name', 'T'])
    gitC(['config', 'commit.gpgsign', 'false'])
    writeFileSync(path.join(cloneDir, 'f.txt'), 'x\n')
    gitC(['add', 'f.txt'])
    gitC(['commit', '-qm', 'seed'])
    gitC(['push', '-q', 'origin', 'main']) // no -u: upstream stays unset
    gitC(['checkout', '-qb', 'main-test'])
    writeFileSync(path.join(cloneDir, 'g.txt'), 'y\n')
    gitC(['add', 'g.txt'])
    gitC(['commit', '-qm', 'work 1'])
    gitC(['push', '-q', 'origin', 'main-test']) // remote ref exists, no tracking
    writeFileSync(path.join(cloneDir, 'h.txt'), 'z\n')
    gitC(['add', 'h.txt'])
    gitC(['commit', '-qm', 'work 2'])
    gitC(['checkout', '-qb', 'brand-new'])
  })

  afterAll(() => {
    if (originDir) rmSync(originDir, { recursive: true, force: true })
    if (cloneDir) rmSync(cloneDir, { recursive: true, force: true })
  })

  test('should derive ahead/behind from origin/<branch> when upstream is unset', async () => {
    const s = await repoStatus(cloneDir)
    expect(s.branch).toBe('brand-new')
    expect(s.hasUpstream).toBe(false)
    expect(s.upstreamAssumed).toBe(false) // no origin/brand-new ref → discovery maps ahead to null
    gitC(['checkout', '-q', 'main-test'])
    const t = await repoStatus(cloneDir)
    expect(t.hasUpstream).toBe(false)
    expect(t.upstreamAssumed).toBe(true)
    expect(t.ahead).toBe(1) // 'work 2' not on origin/main-test
    expect(t.behind).toBe(0)
  })

  test('should report zero ahead when fully pushed without upstream', async () => {
    gitC(['push', '-q', 'origin', 'main-test'])
    const s = await repoStatus(cloneDir)
    expect(s.upstreamAssumed).toBe(true)
    expect(s.ahead).toBe(0)
  })
})

describe('resolveGithubRequest', () => {
  let idRepo: string
  const gitId = (args: string[]): string => execFileSync('git', args, { cwd: idRepo, encoding: 'utf8' })
  const HEAD_OID = 'c'.repeat(40)

  beforeEach(() => {
    idRepo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-ghid-'))
    gitId(['init', '-q', '-b', 'main'])
  })
  afterEach(() => {
    rmSync(idRepo, { recursive: true, force: true })
  })

  test('should prefer a GitHub tracking remote over a Gitea origin', async () => {
    gitId(['remote', 'add', 'origin', 'https://gitea.example.com/acme/widgets.git'])
    gitId(['remote', 'add', 'github', 'git@github.com:acme/widgets.git'])
    gitId(['config', 'branch.main.remote', 'github'])
    const res = await resolveGithubRequest(idRepo, 'main', HEAD_OID)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.request.headRepository).toBe('acme/widgets')
      expect(res.request.configuredBaseRepository).toBeNull()
    }
  })

  test('should fall back to GitHub origin when no tracking remote', async () => {
    gitId(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    const res = await resolveGithubRequest(idRepo, 'feat/x', HEAD_OID)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.request.headRepository).toBe('acme/widgets')
  })

  test('should resolve the sole GitHub remote with a non-GitHub origin', async () => {
    gitId(['remote', 'add', 'origin', 'https://gitea.example.com/acme/widgets.git'])
    gitId(['remote', 'add', 'upstream', 'ssh://git@github.com:22/upstream-org/widgets'])
    const res = await resolveGithubRequest(idRepo, 'feat/x', HEAD_OID)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.request.headRepository).toBe('upstream-org/widgets')
  })

  test('should record a GitHub upstream as the configured base', async () => {
    gitId(['remote', 'add', 'origin', 'git@github.com:me/widgets.git'])
    gitId(['remote', 'add', 'upstream', 'https://github.com/upstream-org/widgets.git'])
    const res = await resolveGithubRequest(idRepo, 'feat/x', HEAD_OID)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.request.headRepository).toBe('me/widgets')
      expect(res.request.configuredBaseRepository).toBe('upstream-org/widgets')
    }
  })

  test('should be ambiguous with multiple GitHub remotes and no tracking', async () => {
    gitId(['remote', 'add', 'a', 'git@github.com:acme/one.git'])
    gitId(['remote', 'add', 'b', 'git@github.com:acme/two.git'])
    const res = await resolveGithubRequest(idRepo, 'feat/x', HEAD_OID)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('ambiguous')
  })

  test('should reject hostile branch names and missing HEAD oids', async () => {
    gitId(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    const hostile = await resolveGithubRequest(idRepo, '--upload-pack=evil', HEAD_OID)
    expect(hostile.ok).toBe(false)
    const unborn = await resolveGithubRequest(idRepo, 'main', null)
    expect(unborn.ok).toBe(false)
    if (!unborn.ok) expect(unborn.reason).toBe('unsupported')
  })

  test('should report unsupported for non-GitHub hosts only', async () => {
    gitId(['remote', 'add', 'origin', 'https://gitea.example.com/acme/widgets.git'])
    const res = await resolveGithubRequest(idRepo, 'main', HEAD_OID)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unsupported')
  })

  test('should parse scp-style and ssh:// GitHub urls', async () => {
    gitId(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'])
    const scp = await resolveGithubRequest(idRepo, 'main', HEAD_OID)
    expect(scp.ok && scp.request.headRepository).toBe('acme/widgets')
    rmSync(idRepo, { recursive: true, force: true })
    idRepo = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-ghid-'))
    gitId(['init', '-q', '-b', 'main'])
    gitId(['remote', 'add', 'origin', 'ssh://git@github.com/acme/widgets.git'])
    const ssh = await resolveGithubRequest(idRepo, 'main', HEAD_OID)
    expect(ssh.ok && ssh.request.headRepository).toBe('acme/widgets')
  })
})
