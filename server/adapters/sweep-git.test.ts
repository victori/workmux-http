import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { WorktreeView } from '../../shared/types.js'
import { SweepGit, type SweepGitFacts } from './sweep-git.js'

/**
 * Real-git evidence collection against disposable repos with a local bare
 * remote; no real origin is ever contacted.
 */

let sandbox: string
let remote: string
let main: string
let wtPath: string

// The developer's global config may sign commits; disposable test repos must not.
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign'
process.env.GIT_CONFIG_VALUE_0 = 'false'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function view(overrides: Partial<WorktreeView> = {}): WorktreeView {
  return {
    id: 'wt_test',
    project: 'proj',
    projectPath: main,
    handle: 'feat-x',
    branch: 'feat/x',
    path: wtPath,
    isMain: false,
    mode: 'window',
    hasUncommittedChanges: false,
    isOpen: false,
    agentStatuses: [],
    createdAt: 0,
    prUrl: null,
    unpushed: null,
    ...overrides,
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'wmhttp-sweep-'))
  remote = path.join(sandbox, 'remote.git')
  main = path.join(sandbox, 'main')
  wtPath = path.join(sandbox, 'feat-x')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['clone', '-q', remote, main])
  git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  git(main, ['push', '-q', '-u', 'origin', 'main'])
  git(main, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  git(main, ['checkout', '-q', '-b', 'feat/x'])
  git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'work'])
  git(main, ['push', '-q', '-u', 'origin', 'feat/x'])
  git(main, ['checkout', '-q', 'main'])
  git(main, ['worktree', 'add', '-q', wtPath, 'feat/x'])
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('SweepGit.inspect', () => {
  test('should collect clean facts for a pushed branch', async () => {
    const facts = await new SweepGit().inspect(view())
    expect(facts).toMatchObject({
      branch: 'feat/x',
      isBase: false,
      detached: false,
      unborn: false,
      dirty: false,
      untracked: false,
      conflicts: false,
      operationInProgress: false,
      upstream: 'present',
      upstreamRemote: 'origin',
      upstreamBranch: 'feat/x',
      mergedIntoBase: false,
      unsafeRefs: false,
    })
    expect(facts.headOid).toMatch(/^[0-9a-f]{40}$/)
    expect(facts.baseOid).toMatch(/^[0-9a-f]{40}$/)
  })

  test('should flag tracked modifications and staged changes as dirty', async () => {
    writeFileSync(path.join(wtPath, 'tracked-mod.txt'), 'x\n')
    git(wtPath, ['add', 'tracked-mod.txt'])
    git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'add file'])
    writeFileSync(path.join(wtPath, 'tracked-mod.txt'), 'y\n')
    const facts = await new SweepGit().inspect(view())
    expect(facts.dirty).toBe(true)
  })

  test('should flag untracked files separately from dirty', async () => {
    writeFileSync(path.join(wtPath, 'scratch.txt'), 'temp\n')
    const facts = await new SweepGit().inspect(view())
    expect(facts.untracked).toBe(true)
    expect(facts.dirty).toBe(false)
  })

  test('should flag merge conflicts', async () => {
    // Diverge feat/x and main on the same line, then merge into the worktree.
    writeFileSync(path.join(wtPath, 'clash.txt'), 'feat\n')
    git(wtPath, ['add', 'clash.txt'])
    git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'feat line'])
    git(main, ['checkout', '-q', 'main'])
    writeFileSync(path.join(main, 'clash.txt'), 'main\n')
    git(main, ['add', 'clash.txt'])
    git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'main line'])
    git(main, ['push', '-q', 'origin', 'main'])
    try {
      git(wtPath, ['merge', 'origin/main', '--no-edit'])
    } catch {
      /* conflict expected */
    }
    const facts = await new SweepGit().inspect(view())
    expect(facts.conflicts).toBe(true)
    expect(facts.operationInProgress).toBe(true)
  })

  test('should flag in-progress cherry-pick', async () => {
    writeFileSync(path.join(main, 'clash2.txt'), 'main\n')
    git(main, ['add', 'clash2.txt'])
    git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'main only'])
    git(main, ['push', '-q', 'origin', 'main'])
    writeFileSync(path.join(wtPath, 'clash2.txt'), 'feat\n')
    git(wtPath, ['add', 'clash2.txt'])
    git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'feat only'])
    const sha = git(wtPath, ['rev-parse', 'HEAD'])
    git(main, ['checkout', '-q', 'main'])
    try {
      git(main, ['cherry-pick', sha])
    } catch {
      /* conflict expected */
    }
    const facts = await new SweepGit().inspect(view({ path: main, branch: 'main' }))
    expect(facts.operationInProgress).toBe(true)
    expect(facts.isBase).toBe(true)
  })

  test('should prove ancestry for merged branches', async () => {
    git(main, ['checkout', '-q', 'main'])
    git(main, ['merge', '-q', '--no-ff', 'feat/x', '-m', 'merge feat'])
    git(main, ['push', '-q', 'origin', 'main'])
    const facts = await new SweepGit().inspect(view())
    expect(facts.mergedIntoBase).toBe(true)
  })

  test('should not treat squash-merged HEAD as an ancestor', async () => {
    writeFileSync(path.join(wtPath, 'feature.txt'), 'impl\n')
    git(wtPath, ['add', 'feature.txt'])
    git(wtPath, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'feature impl'])
    git(main, ['checkout', '-q', 'main'])
    git(main, ['merge', '-q', '--squash', 'feat/x'])
    git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '-m', 'squashed feat'])
    git(main, ['push', '-q', 'origin', 'main'])
    const facts = await new SweepGit().inspect(view())
    expect(facts.mergedIntoBase).toBe(false)
  })

  test('should report none without upstream configuration', async () => {
    git(main, ['checkout', '-q', '-b', 'local-only'])
    git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'local'])
    git(main, ['checkout', '-q', 'main'])
    const localWt = path.join(sandbox, 'local-only')
    git(main, ['worktree', 'add', '-q', localWt, 'local-only'])
    const facts = await new SweepGit().inspect(view({ path: localWt, branch: 'local-only' }))
    expect(facts.upstream).toBe('none')
  })

  test('should verify gone only via the remote query', async () => {
    git(main, ['push', '-q', 'origin', '--delete', 'feat/x'])
    const facts = await new SweepGit().inspect(view())
    expect(facts.upstream).toBe('gone')
  })

  test('should report unknown when the remote cannot be read', async () => {
    git(main, ['remote', 'set-url', 'origin', path.join(sandbox, 'no-such-remote.git')])
    const facts = await new SweepGit().inspect(view())
    expect(facts.upstream).toBe('unknown')
  })

  test('should never execute hostile remote helper urls', async () => {
    const marker = path.join(sandbox, 'pwned')
    git(main, ['remote', 'set-url', 'origin', `ext::sh -c 'touch ${marker}'`])
    const facts = await new SweepGit().inspect(view())
    expect(facts.upstream).toBe('unknown')
    expect(existsSync(marker)).toBe(false)
  })

  test('should flag refs that fail SAFE_REV', async () => {
    git(main, ['checkout', '-q', '-b', 'feat@x'])
    git(main, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'weird'])
    git(main, ['checkout', '-q', 'main'])
    const weirdWt = path.join(sandbox, 'feat-at-x')
    git(main, ['worktree', 'add', '-q', weirdWt, 'feat@x'])
    const facts = await new SweepGit().inspect(view({ path: weirdWt, branch: 'feat@x' }))
    expect(facts.unsafeRefs).toBe(true)
  })

  test('should reject inspection for non-repositories instead of returning clean', async () => {
    const dir = mkdtempSync(path.join(sandbox, 'not-a-repo-'))
    await expect(new SweepGit().inspect(view({ path: dir }))).rejects.toThrow()
  })

  test('should mark the base worktree as isBase', async () => {
    const facts = await new SweepGit().inspect(view({ path: main, branch: 'main', isMain: true }))
    expect(facts.isBase).toBe(true)
  })
})

describe('SweepGit.removed', () => {
  test('should confirm directory removal with branch retained', async () => {
    git(main, ['worktree', 'remove', wtPath])
    const ok = await new SweepGit().removed(view(), true)
    expect(ok).toBe(true)
  })

  test('should require branch deletion when branches are not kept', async () => {
    git(main, ['worktree', 'remove', wtPath])
    const retained = await new SweepGit().removed(view(), false)
    expect(retained).toBe(false)
    git(main, ['branch', '-D', 'feat/x'])
    const gone = await new SweepGit().removed(view(), false)
    expect(gone).toBe(true)
  })

  test('should report unconfirmed removal while the directory remains', async () => {
    const still = await new SweepGit().removed(view(), true)
    expect(still).toBe(false)
  })
})

describe('SweepGitFacts typing', () => {
  test('should expose the git-only fields of sweep facts', async () => {
    const facts: SweepGitFacts = await new SweepGit().inspect(view())
    const keys = Object.keys(facts).sort()
    expect(keys).toEqual(
      [
        'baseOid',
        'branch',
        'canonicalPath',
        'conflicts',
        'detached',
        'dirty',
        'headOid',
        'isBase',
        'mergedIntoBase',
        'operationInProgress',
        'repoRoot',
        'unborn',
        'unsafeRefs',
        'untracked',
        'upstream',
        'upstreamBranch',
        'upstreamRemote',
      ].sort(),
    )
  })
})
