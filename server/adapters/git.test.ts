import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { addPaths, repoStatus, runCommit } from './git.js'

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
