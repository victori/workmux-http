import { describe, expect, test } from 'vitest'
import type { GithubStatus } from '../../shared/types.js'
import { classifySweep, type SweepFacts } from './sweep-policy.js'

const HEAD = 'a'.repeat(40)
const BASE = 'f'.repeat(40)

const mergedPr: GithubStatus = {
  state: 'ready',
  pr: {
    number: 12,
    title: 'Done',
    url: 'https://github.com/acme/widgets/pull/12',
    state: 'merged',
    review: 'approved',
    headOid: HEAD,
    headRepository: 'acme/widgets',
    baseRepository: 'acme/widgets',
    baseBranch: 'main',
  },
  ci: null,
  observedAt: 1,
  attemptedAt: 1,
  error: null,
}

function cleanFacts(): SweepFacts {
  return {
    worktreeId: 'wt_abc',
    targetLabel: 'proj/feat-x',
    branch: 'feat/x',
    path: '/repos/proj/.claude/worktrees/feat-x',
    headOid: HEAD,
    baseOid: BASE,
    isMain: false,
    isBase: false,
    detached: false,
    unborn: false,
    dirty: false,
    untracked: false,
    conflicts: false,
    operationInProgress: false,
    liveAgentPaneIds: [],
    isOpen: false,
    healthy: true,
    unsafeRefs: false,
    identityChanged: false,
    managed: true,
    upstream: 'present',
    mergedIntoBase: null,
    github: mergedPr,
  }
}

describe('classifySweep reasons', () => {
  test('should prefer pr_merged over pr_closed over upstream_gone over merged_locally', () => {
    expect(classifySweep(cleanFacts(), true).reason).toBe('pr_merged')

    const closed: SweepFacts = {
      ...cleanFacts(),
      github: { ...mergedPr, pr: { ...mergedPr.pr!, state: 'closed' } },
    }
    expect(classifySweep(closed, true).reason).toBe('pr_closed')

    const gone: SweepFacts = { ...cleanFacts(), github: { ...mergedPr, pr: null }, upstream: 'gone' }
    expect(classifySweep(gone, true).reason).toBe('upstream_gone')

    const local: SweepFacts = {
      ...cleanFacts(),
      github: { ...mergedPr, pr: null },
      upstream: 'none',
      mergedIntoBase: true,
    }
    expect(classifySweep(local, true).reason).toBe('merged_locally')
  })

  test('should require exact PR head identity for PR reasons', () => {
    const moved: SweepFacts = {
      ...cleanFacts(),
      github: { ...mergedPr, pr: { ...mergedPr.pr!, headOid: 'b'.repeat(40) } },
      upstream: 'none',
      mergedIntoBase: null,
    }
    const candidate = classifySweep(moved, true)
    expect(candidate.reason).toBeNull()
    expect(candidate.blockers).toContain('PR head does not match the current local HEAD')
  })

  test('should not treat unknown upstream as gone', () => {
    const facts: SweepFacts = {
      ...cleanFacts(),
      github: { ...mergedPr, pr: null },
      upstream: 'unknown',
      mergedIntoBase: null,
    }
    const candidate = classifySweep(facts, true)
    expect(candidate.reason).toBeNull()
    expect(candidate.blockers).toContain('upstream state is unknown')
  })

  test('should not select merged_locally without ancestry proof', () => {
    const facts: SweepFacts = { ...cleanFacts(), github: { ...mergedPr, pr: null }, upstream: 'none', mergedIntoBase: null }
    const candidate = classifySweep(facts, true)
    expect(candidate.reason).toBeNull()
  })
})

describe('classifySweep blockers', () => {
  test('should never select a dirty merged-PR worktree', () => {
    const facts = cleanFacts()
    facts.dirty = true
    expect(classifySweep(facts, true).blockers).toContain('worktree has local changes')
  })

  test('should require ancestry proof when deleting the local branch', () => {
    const facts = cleanFacts()
    facts.mergedIntoBase = false
    expect(classifySweep(facts, false).blockers).toContain('branch is not proven merged into base')
  })

  test('should keep squash-merged PR branches when ancestry is unproven', () => {
    const facts = cleanFacts()
    facts.mergedIntoBase = false
    const candidate = classifySweep(facts, false)
    expect(candidate.reason).toBe('pr_merged')
    expect(candidate.blockers).toContain('branch is not proven merged into base')
    expect(classifySweep(facts, true).blockers).not.toContain('branch is not proven merged into base')
  })

  test('should block main and base worktrees', () => {
    expect(classifySweep({ ...cleanFacts(), isMain: true }, true).blockers).toContain('main worktree is never swept')
    expect(classifySweep({ ...cleanFacts(), isBase: true }, true).blockers).toContain('base branch worktree is never swept')
  })

  test('should block detached and unborn HEAD', () => {
    expect(classifySweep({ ...cleanFacts(), detached: true }, true).blockers).toContain('detached HEAD')
    expect(classifySweep({ ...cleanFacts(), unborn: true }, true).blockers).toContain('worktree has no commits')
  })

  test('should block live agent panes even when done or stale', () => {
    const candidate = classifySweep({ ...cleanFacts(), liveAgentPaneIds: ['%42'] }, true)
    expect(candidate.blockers).toContain('live agent pane is attached')
  })

  test('should block open PRs regardless of other cleanup hints', () => {
    const open: GithubStatus = { ...mergedPr, pr: { ...mergedPr.pr!, state: 'open' } }
    const candidate = classifySweep({ ...cleanFacts(), github: open, upstream: 'gone' }, true)
    expect(candidate.blockers).toContain('pull request is open')
    expect(candidate.reason).toBeNull()

    const draft: GithubStatus = { ...mergedPr, pr: { ...mergedPr.pr!, state: 'draft' } }
    expect(classifySweep({ ...cleanFacts(), github: draft }, true).blockers).toContain('pull request is open')
  })

  test('should block unverified GitHub state but permit unsupported with warning', () => {
    for (const state of ['unavailable', 'loading', 'stale'] as const) {
      const candidate = classifySweep({ ...cleanFacts(), github: { ...mergedPr, state, pr: null } }, true)
      expect(candidate.blockers).toContain('GitHub PR state could not be verified')
    }
    const none: GithubStatus = { state: 'unsupported', pr: null, ci: null, observedAt: null, attemptedAt: null, error: null }
    const candidate = classifySweep(
      { ...cleanFacts(), github: none, upstream: 'gone' },
      true,
    )
    expect(candidate.blockers).toHaveLength(0)
    expect(candidate.reason).toBe('upstream_gone')
    expect(candidate.warnings).toContain('PR check unsupported')
  })

  test('should block unknown sources, unsafe refs, identity drift, and unmanaged targets', () => {
    expect(classifySweep({ ...cleanFacts(), healthy: false }, true).blockers).toContain('source state is unknown')
    expect(classifySweep({ ...cleanFacts(), unsafeRefs: true }, true).blockers).toContain('refs are not safe to operate on')
    expect(classifySweep({ ...cleanFacts(), identityChanged: true }, true).blockers).toContain('worktree identity changed since scan')
    expect(classifySweep({ ...cleanFacts(), managed: false }, true).blockers).toContain('target is not managed')
  })

  test('should block untracked files, conflicts, and in-progress git operations', () => {
    expect(classifySweep({ ...cleanFacts(), untracked: true }, true).blockers).toContain('worktree has untracked files')
    expect(classifySweep({ ...cleanFacts(), conflicts: true }, true).blockers).toContain('worktree has merge conflicts')
    expect(classifySweep({ ...cleanFacts(), operationInProgress: true }, true).blockers).toContain('a git operation is in progress')
  })

  test('should accumulate every blocker independently', () => {
    const facts: SweepFacts = {
      ...cleanFacts(),
      dirty: true,
      conflicts: true,
      isMain: true,
      liveAgentPaneIds: ['%1', '%2'],
    }
    const candidate = classifySweep(facts, true)
    expect(candidate.blockers).toEqual(
      expect.arrayContaining([
        'main worktree is never swept',
        'worktree has local changes',
        'worktree has merge conflicts',
        'live agent pane is attached',
      ]),
    )
    expect(candidate.blockers.length).toBeGreaterThanOrEqual(4)
  })
})

describe('classifySweep warnings and purity', () => {
  test('should warn when sweeping an open worktree window', () => {
    const candidate = classifySweep(cleanFacts(), true)
    expect(candidate.warnings).not.toContain('worktree window is open; remaining panes/processes will be closed')
    const open = classifySweep({ ...cleanFacts(), isOpen: true }, true)
    expect(open.warnings).toContain('worktree window is open; remaining panes/processes will be closed')
  })

  test('should never mutate the facts input', () => {
    const facts = cleanFacts()
    const snapshot = JSON.stringify(facts)
    classifySweep(facts, false)
    classifySweep(facts, true)
    expect(JSON.stringify(facts)).toBe(snapshot)
  })

  test('should carry identity fields onto the candidate', () => {
    const candidate = classifySweep(cleanFacts(), true)
    expect(candidate).toMatchObject({ worktreeId: 'wt_abc', targetLabel: 'proj/feat-x', branch: 'feat/x', path: cleanFacts().path })
  })
})
