import type { GithubStatus, SweepCandidate, SweepReason } from '../../shared/types.js'

/**
 * Pure sweep-eligibility policy (design §4). No clock, network, mutation,
 * or I/O — the service supplies fresh facts; this decides eligibility.
 * Blockers accumulate independently of the reason: a cleanup hint never
 * overrides dirty/live-agent/open-PR protections.
 */
export interface SweepFacts {
  worktreeId: string
  targetLabel: string
  branch: string | null
  path: string | null
  headOid: string | null
  baseOid: string | null
  isMain: boolean
  isBase: boolean
  /** HEAD detached (no branch). */
  detached: boolean
  unborn: boolean
  /** Tracked modifications (unstaged or staged). */
  dirty: boolean
  untracked: boolean
  conflicts: boolean
  operationInProgress: boolean
  liveAgentPaneIds: string[]
  isOpen: boolean
  /** git/tmux/workmux sources reported healthy this cycle. */
  healthy: boolean
  unsafeRefs: boolean
  identityChanged: boolean
  managed: boolean
  upstream: 'none' | 'present' | 'gone' | 'unknown'
  /** Local HEAD is an ancestor of the resolved base; null = unproven. */
  mergedIntoBase: boolean | null
  github: GithubStatus | null
}

const OPEN_PR_STATES: Record<string, true> = { open: true, draft: true }

export function classifySweep(facts: SweepFacts, keepBranches: boolean): SweepCandidate {
  const blockers: string[] = []
  const warnings: string[] = []

  if (!facts.managed) blockers.push('target is not managed')
  if (facts.isMain) blockers.push('main worktree is never swept')
  if (facts.isBase) blockers.push('base branch worktree is never swept')
  if (facts.detached) blockers.push('detached HEAD')
  if (facts.unborn) blockers.push('worktree has no commits')
  if (facts.unsafeRefs) blockers.push('refs are not safe to operate on')
  if (facts.identityChanged) blockers.push('worktree identity changed since scan')
  if (facts.dirty) blockers.push('worktree has local changes')
  if (facts.untracked) blockers.push('worktree has untracked files')
  if (facts.conflicts) blockers.push('worktree has merge conflicts')
  if (facts.operationInProgress) blockers.push('a git operation is in progress')
  if (facts.liveAgentPaneIds.length > 0) blockers.push('live agent pane is attached')
  if (!facts.healthy) blockers.push('source state is unknown')
  if (facts.isOpen) warnings.push('worktree window is open; remaining panes/processes will be closed')

  const github = facts.github
  let reason: SweepReason | null = null
  let prProtected = false

  if (github === null || github.state === 'loading' || github.state === 'stale' || github.state === 'unavailable') {
    // GitHub-backed targets need verifiable current PR association;
    // unsupported (non-GitHub) targets may rely on local evidence.
    blockers.push('GitHub PR state could not be verified')
  } else if (github.state === 'unsupported') {
    warnings.push('PR check unsupported')
  } else {
    const pr = github.pr
    let prOpen = false
    if (pr && OPEN_PR_STATES[pr.state] === true) {
      blockers.push('pull request is open')
      prOpen = true
    }
    if (pr && facts.headOid !== null && pr.headOid !== facts.headOid) {
      blockers.push('PR head does not match the current local HEAD')
    }
    if (pr && !prOpen && pr.headOid === facts.headOid) {
      reason = pr.state === 'merged' ? 'pr_merged' : 'pr_closed'
    }
    // An open PR protects the worktree even when other cleanup hints exist.
    if (prOpen) {
      reason = null
      prProtected = true
    }
  }

  if (reason === null && !prProtected) {
    if (facts.upstream === 'gone') reason = 'upstream_gone'
    else if (facts.upstream === 'unknown') blockers.push('upstream state is unknown')
    else if (facts.upstream === 'none' && facts.mergedIntoBase === true) reason = 'merged_locally'
  }

  if (!keepBranches && facts.mergedIntoBase !== true) {
    blockers.push('branch is not proven merged into base')
  }

  return {
    worktreeId: facts.worktreeId,
    targetLabel: facts.targetLabel,
    branch: facts.branch ?? '',
    path: facts.path ?? '',
    reason,
    blockers,
    warnings,
  }
}
