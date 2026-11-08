import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { addPaths, hasOrigin, push, repoStatus, runCommit, unpushedCommits } from './git.js'

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
