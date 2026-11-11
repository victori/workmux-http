import { access, realpath } from 'node:fs/promises'
import { run } from '../exec.js'
import { SAFE_REV, repoStatus, resolveBase } from './git.js'
import type { WorktreeView } from '../../shared/types.js'

/**
 * Git-only safety evidence for the clean sweep (design §4). Every read goes
 * through the argv-only exec gateway; failures REJECT — a read failure is
 * never reported as clean. `upstream` absence is only ever established by a
 * successful `ls-remote` documented no-match, never by a missing local ref,
 * and remote helper protocols are refused before execution.
 */
export interface SweepGitFacts {
  canonicalPath: string
  repoRoot: string
  branch: string | null
  headOid: string | null
  baseOid: string | null
  isBase: boolean
  detached: boolean
  unborn: boolean
  dirty: boolean
  untracked: boolean
  conflicts: boolean
  operationInProgress: boolean
  upstreamRemote: string | null
  upstreamBranch: string | null
  upstream: 'none' | 'present' | 'gone' | 'unknown'
  mergedIntoBase: boolean | null
  unsafeRefs: boolean
}

export interface SweepGitLike {
  inspect(worktree: WorktreeView): Promise<SweepGitFacts>
  removed(worktree: WorktreeView, keepBranches: boolean): Promise<boolean>
}

const OPERATION_SENTINELS = [
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
]

const HEX_OID = /^[0-9a-f]{40}$/

/** Refuse option-like names and arbitrary helper protocols (`ext::…`). */
function safeRemoteUrl(url: string | null): url is string {
  if (!url) return false
  const trimmed = url.trim()
  return trimmed !== '' && !trimmed.startsWith('-') && !/^[A-Za-z0-9._-]+::/.test(trimmed)
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const res = await run(['git', ...args], { cwd })
  return { code: res.code, out: res.stdout.trim(), err: res.stderr }
}

async function mustGit(cwd: string, args: string[]): Promise<string> {
  const res = await git(cwd, args)
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} failed in ${cwd}: ${res.err.trim() || `exit ${res.code}`}`)
  }
  return res.out
}

export class SweepGit implements SweepGitLike {
  async inspect(worktree: WorktreeView): Promise<SweepGitFacts> {
    const canonicalPath = await realpath(worktree.path).catch(() => worktree.path)
    const st = await repoStatus(canonicalPath)
    const repoRoot = await mustGit(canonicalPath, ['rev-parse', '--show-toplevel'])

    const detached = st.branch === '(detached)'
    const unborn = st.unborn
    const headOid = HEX_OID.test(st.oid) ? st.oid : null
    const branch = detached || unborn ? null : st.branch

    const base = await resolveBase(canonicalPath)
    const unsafeRefs = (branch !== null && !SAFE_REV.test(branch)) || (base !== null && !SAFE_REV.test(base))

    let baseOid: string | null = null
    if (base !== null && SAFE_REV.test(base)) {
      const verified = await git(canonicalPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`])
      baseOid = verified.code === 0 && HEX_OID.test(verified.out) ? verified.out : null
    }
    const isBase = branch !== null && base !== null && branch === base

    let operationInProgress = false
    for (const sentinel of OPERATION_SENTINELS) {
      const located = await git(canonicalPath, ['rev-parse', '--git-path', sentinel])
      if (located.code !== 0 || !located.out) continue
      const sentinelPath = located.out.startsWith('/') ? located.out : `${canonicalPath}/${located.out}`
      if (await access(sentinelPath).then(() => true).catch(() => false)) {
        operationInProgress = true
        break
      }
    }

    const upstream = await this.upstreamState(canonicalPath, branch)
    let mergedIntoBase: boolean | null = null
    if (headOid && baseOid) {
      const anc = await git(canonicalPath, ['merge-base', '--is-ancestor', headOid, baseOid])
      if (anc.code === 0) mergedIntoBase = true
      else if (anc.code === 1) mergedIntoBase = false
      else mergedIntoBase = null
    }

    return {
      canonicalPath,
      repoRoot,
      branch,
      headOid,
      baseOid,
      isBase,
      detached,
      unborn,
      dirty: st.hasStaged || st.hasUnstaged,
      untracked: st.untracked.length > 0,
      conflicts: st.conflicts.length > 0,
      operationInProgress,
      upstreamRemote: upstream.remote,
      upstreamBranch: upstream.branch,
      upstream: upstream.state,
      mergedIntoBase,
      unsafeRefs,
    }
  }

  /**
   * Configured upstream only. `gone` requires the documented ls-remote
   * exit-code-2 no-match against the configured remote/ref; a missing local
   * tracking ref proves nothing, and helper protocols are never executed.
   */
  private async upstreamState(
    cwd: string,
    branch: string | null,
  ): Promise<{ remote: string | null; branch: string | null; state: 'none' | 'present' | 'gone' | 'unknown' }> {
    if (branch === null || !SAFE_REV.test(branch)) return { remote: null, branch: null, state: 'unknown' }
    const remoteRes = await git(cwd, ['config', '--get', `branch.${branch}.remote`])
    const remote = remoteRes.code === 0 && remoteRes.out ? remoteRes.out : null
    if (remote === null) return { remote: null, branch: null, state: 'none' }
    const mergeRes = await git(cwd, ['config', '--get', `branch.${branch}.merge`])
    const mergeRef = mergeRes.code === 0 ? mergeRes.out : ''
    const upstreamBranch = mergeRef.startsWith('refs/heads/') ? mergeRef.slice('refs/heads/'.length) : mergeRef || null
    if (upstreamBranch === null || !SAFE_REV.test(remote) || !SAFE_REV.test(upstreamBranch)) {
      return { remote, branch: upstreamBranch, state: 'unknown' }
    }
    const urlRes = await git(cwd, ['config', '--get', `remote.${remote}.url`])
    if (!safeRemoteUrl(urlRes.out)) return { remote, branch: upstreamBranch, state: 'unknown' }
    const probe = await git(cwd, ['ls-remote', '--exit-code', '--heads', remote, upstreamBranch])
    if (probe.code === 0) return { remote, branch: upstreamBranch, state: 'present' }
    if (probe.code === 2) return { remote, branch: upstreamBranch, state: 'gone' }
    return { remote, branch: upstreamBranch, state: 'unknown' }
  }

  /**
   * Postcondition: the directory is gone AND the branch matches the promise
   * (retained when keepBranches, deleted otherwise). Throws when the check
   * itself fails so the caller reports an unknown outcome, never a lie.
   */
  async removed(worktree: WorktreeView, keepBranches: boolean): Promise<boolean> {
    const canonicalPath = await realpath(worktree.path).catch(() => worktree.path)
    const dirGone = !(await access(canonicalPath).then(() => true).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error(`cannot confirm removal of ${canonicalPath}: ${String(err)}`)
    }))
    const branch = worktree.branch
    if (branch === null || !SAFE_REV.test(branch)) return dirGone
    const queryCwd = dirGone ? worktree.projectPath : canonicalPath
    // `rev-parse --verify --quiet` exit codes: 0 = ref exists, 1 = verified
    // absent, >=2 = inspection failed (not a repo, corrupt, spawn error).
    // Only 0/1 are proof; anything else must surface as unknown.
    const res = await git(queryCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => null)
    if (res === null || res.code >= 2) {
      throw new Error(
        `cannot confirm branch state after removal${res ? ` (git exit ${res.code}: ${res.err.trim()})` : ''}`,
      )
    }
    const exists = res.code === 0
    return dirGone && exists === keepBranches
  }
}
