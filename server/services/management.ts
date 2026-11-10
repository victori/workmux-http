import { randomBytes } from 'node:crypto'
import type {
  ActionType,
  AddResult,
  AgentView,
  CommitInfo,
  CommitListResponse,
  DiffMode,
  DiffResponse,
  HunkActionResult,
  PrepareActionRequest,
  PreparedAction,
  CreateWorktreeRequest,
  OperationView,
} from '../../shared/types.js'
import { BOUNDS, type AppConfig } from '../config.js'
import { buildCommitArgv, buildPushArgv } from '../commitCmd.js'
import type { TmuxLike } from '../adapters/tmux.js'
import { Workmux } from '../adapters/workmux.js'
import * as git from '../adapters/git.js'
import { parseDiff, buildHunkPatch, splitHunkText, type ParsedFile } from '../hunks.js'
import { confirmTokenOf, isValidWorktreeName, snapshotId, worktreeId } from '../targets.js'
import type { Discovery } from './discovery.js'
import type { Operations } from './operations.js'
import { TargetLocks } from './target-locks.js'

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export class TargetNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetNotFoundError'
  }
}

export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfirmationError'
  }
}

interface IssuedToken {
  at: number
  key: string
}

/** Pending-change lists from a repo status that may be unavailable. */
function pendingFrom(status: git.RepoStatus | null) {
  return {
    untracked: status?.untracked ?? [],
    unstaged: status?.unstaged ?? [],
    staged: status?.staged ?? [],
    conflicts: status?.conflicts ?? [],
    hasStaged: status?.hasStaged ?? false,
    pendingKnown: status !== null,
  }
}

/** Diffs, hunk staging, creation, and confirmed destructive actions. */
export class Management {
  private issued = new Map<string, IssuedToken>()
  private readonly locks: TargetLocks

  constructor(
    private readonly cfg: AppConfig,
    private readonly tmux: TmuxLike,
    private readonly workmux: Workmux,
    private readonly discovery: Discovery,
    private readonly operations: Operations,
    locks: TargetLocks = new TargetLocks(operations),
  ) {
    this.locks = locks
  }

  async diff(targetId: string, mode: DiffMode, sha?: string): Promise<DiffResponse> {
    const wt = (await this.discovery.worktreeTargets()).get(targetId)
    if (!wt) throw new TargetNotFoundError(`unknown worktree ${targetId}`)
    const unborn = !(await git.hasHead(wt.path).catch(() => false))
    if (unborn) {
      const status = await git.repoStatus(wt.path).catch(() => null)
      return {
        worktreeId: targetId,
        mode,
        base: null,
        baseMissing: mode === 'branch',
        unborn: true,
        snapshotId: 'unborn',
        files: [],
        ...pendingFrom(status),
        commitCmd: await this.commitCmdForWorktree(targetId),
        truncated: false,
        observedAt: Date.now(),
      }
    }
    let base: string | null = null
    let commit: CommitInfo | undefined
    if (mode === 'commit') {
      if (!sha) throw new BadRequestError('sha required for commit diff')
      const info = await git.commitInfo(wt.path, sha)
      if (!info) throw new BadRequestError(`unknown revision: ${sha}`)
      commit = info
      base = info.short
    }
    if (mode === 'branch') {
      base = await git.resolveBase(wt.path)
      if (!base) {
        const status = await git.repoStatus(wt.path).catch(() => null)
        return {
          worktreeId: targetId,
          mode,
          base: null,
          baseMissing: true,
          unborn: false,
          snapshotId: 'no-base',
          files: [],
          ...pendingFrom(status),
          commitCmd: await this.commitCmdForWorktree(targetId),
          truncated: false,
          observedAt: Date.now(),
        }
      }
    }
    const result =
      mode === 'wip'
        ? await git.diffWip(wt.path)
        : mode === 'branch'
          ? await git.diffBranch(wt.path, base!)
          : await git.commitDiff(wt.path, sha!)
    const status = await git.repoStatus(wt.path).catch(() => null)
    const files = result.files.map(toDiffFile)
    const text = result.files.map((f) => f.diff).join('\n')
    return {
      worktreeId: targetId,
      mode,
      base,
      ...(commit ? { commit } : {}),
      baseMissing: false,
      unborn: false,
      snapshotId: snapshotId(`${wt.path}\u0000${mode}\u0000${text}`),
      files,
      ...(mode === 'wip'
        ? pendingFrom(status)
        : { untracked: [], unstaged: [], staged: [], conflicts: [], hasStaged: status?.hasStaged ?? false, pendingKnown: status !== null }),
      commitCmd: await this.commitCmdForWorktree(targetId),
      truncated: result.truncated,
      observedAt: Date.now(),
    }
  }

  /** Commit list for the worktree's HEAD (newest first); unborn → empty. */
  async commits(targetId: string, limit: number): Promise<CommitListResponse> {
    const wt = (await this.discovery.worktreeTargets()).get(targetId)
    if (!wt) throw new TargetNotFoundError(`unknown worktree ${targetId}`)
    return git.commitList(wt.path, limit)
  }

  /**
   * Stage untracked/unstaged paths after revalidating them against a fresh
   * status; client-supplied lists are never trusted.
   */
  async addPending(targetId: string, paths: string[]): Promise<AddResult> {
    const wt = (await this.discovery.worktreeTargets()).get(targetId)
    if (!wt) throw new TargetNotFoundError(`unknown worktree ${targetId}`)
    const malformed = paths.filter(
      (p) => p.trim() === '' || p.startsWith('-') || p.split('/').includes('..'),
    )
    if (malformed.length > 0) {
      return { ok: false, message: 'invalid paths', offenders: malformed }
    }
    return this.locked(targetId, async () => {
      const status = await git.repoStatus(wt.path)
      const pending = new Set([...status.untracked, ...status.unstaged, ...status.conflicts])
      const offenders = paths.filter((p) => !pending.has(p))
      if (offenders.length > 0) {
        return { ok: false, message: 'paths are no longer pending; refresh and retry', offenders }
      }
      await git.addPaths(wt.path, paths)
      this.discovery.invalidateRepo(wt.path)
      return { ok: true }
    })
  }

  /**
   * Undo staging for paths that are currently staged (worktree content
   * untouched). Mirrors addPending: same per-target lock, revalidation
   * against a fresh status, offenders reported instead of fabricated.
   */
  async unstagePending(targetId: string, paths: string[]): Promise<AddResult> {
    const wt = (await this.discovery.worktreeTargets()).get(targetId)
    if (!wt) throw new TargetNotFoundError(`unknown worktree ${targetId}`)
    const malformed = paths.filter(
      (p) => p.trim() === '' || p.startsWith('-') || p.split('/').includes('..'),
    )
    if (malformed.length > 0) {
      return { ok: false, message: 'invalid paths', offenders: malformed }
    }
    return this.locked(targetId, async () => {
      const status = await git.repoStatus(wt.path)
      const offenders = paths.filter((p) => !status.staged.includes(p))
      if (offenders.length > 0) {
        return { ok: false, message: 'paths are not staged; refresh and retry', offenders }
      }
      await git.unstagePaths(wt.path, paths)
      this.discovery.invalidateRepo(wt.path)
      return { ok: true }
    })
  }

  /**
   * Run the operator-configured commit command for this worktree's agent
   * kind against the index. Async via the operations registry (AI commit
   * tools can run long).
   */
  async commitWorktree(targetId: string, message: string): Promise<OperationView> {
    const wt = (await this.discovery.worktreeTargets()).get(targetId)
    if (!wt) throw new TargetNotFoundError(`unknown worktree ${targetId}`)
    const cmd = await this.commitCmdForWorktree(targetId)
    if (!cmd) throw new BadRequestError('commit_cmd_not_configured')
    return this.locked(targetId, async () => {
      const st = await git.repoStatus(wt.path).catch(() => null)
      if (st && st.pendingChanges === 0 && !st.unborn) {
        throw new BadRequestError('nothing_to_commit: worktree has no staged, unstaged, or untracked changes')
      }
      const argv = buildCommitArgv(cmd, message)
      return this.operations.start('commit', wt.handle, async () => {
        const r = await git.runCommit(wt.path, argv, this.cfg.commitTimeoutMs)
        const out = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-BOUNDS.maxCommitOutputBytes)
        if (r.code !== 0) return { output: out || null, error: `commit failed (exit ${r.code})` }
        return { output: out || 'committed' }
      })
    })
  }

  /**
   * Resolve the commit command for the worktree's agents: exactly one
   * configured command across all distinct agent kinds, else null (the UI
   * keeps the agent-commit path).
   */
  private async commitCmdForWorktree(targetId: string): Promise<string | null> {
    const agents = [...(await this.discovery.agentTargets().catch(() => new Map<string, AgentView>())).values()]
      .filter((a) => a.worktreeId === targetId)
    const kinds = [...new Set(agents.map((a) => a.agentKind).filter((k): k is string => k !== null))]
    const cmds = [...new Set(kinds.map((k) => this.cfg.commitCmdFor(k)).filter((c): c is string => c !== null))]
    return cmds.length === 1 ? (cmds[0] ?? null) : null
  }

  /** Same resolution rule as commitCmdForWorktree, for WORKMUX_<KIND>_PUSH_CMD. */
  private async pushCmdForWorktree(targetId: string): Promise<string | null> {
    const agents = [...(await this.discovery.agentTargets().catch(() => new Map<string, AgentView>())).values()]
      .filter((a) => a.worktreeId === targetId)
    const kinds = [...new Set(agents.map((a) => a.agentKind).filter((k): k is string => k !== null))]
    const cmds = [...new Set(kinds.map((k) => this.cfg.pushCmdFor(k)).filter((c): c is string => c !== null))]
    return cmds.length === 1 ? (cmds[0] ?? null) : null
  }

  /**
   * Stage/unstage one server-issued hunk (or split piece). Rejects stale
   * snapshots so another client's or the agent's edits are never clobbered.
   */
  async hunkAction(
    targetId: string,
    action: 'stage' | 'unstage' | 'split',
    req: { snapshotId: string; file: string; hunkIndex: number; piece?: string },
  ): Promise<HunkActionResult> {
    const wt = (await this.discovery.worktreeTargets()).get(targetId)
    if (!wt) throw new TargetNotFoundError(`unknown worktree ${targetId}`)
    return this.locked(targetId, async () => {
      const fresh = await git.diffWip(wt.path)
      const freshId = snapshotId(`${wt.path}\u0000wip\u0000${fresh.files.map((f) => f.diff).join('\n')}`)
      if (freshId !== req.snapshotId) {
        return { ok: false, snapshotStale: true, message: 'diff changed since snapshot; reload and retry' }
      }
      const file = fresh.files.find((f) => f.path === req.file)
      const hunk = file?.hunks[req.hunkIndex]
      if (!file || !hunk) {
        return { ok: false, snapshotStale: true, message: 'hunk no longer present; reload and retry' }
      }
      if (action === 'split') {
        if (!hunk.splittable) return { ok: false, snapshotStale: false, message: 'hunk is not splittable' }
        return { ok: true, snapshotStale: false, pieces: splitHunkText(hunk.text) }
      }
      const hunkText = req.piece ?? hunk.text
      if (req.piece && !pieceMatches(req.piece, hunk)) {
        return { ok: false, snapshotStale: true, message: 'piece does not match current hunk; reload and retry' }
      }
      const patch = buildHunkPatch({ path: file.path, oldPath: file.oldPath, status: file.status }, hunkText)
      const applied = await git.applyToIndex(wt.path, patch, { reverse: action === 'unstage' })
      this.discovery.invalidateRepo(wt.path)
      if (!applied.ok) {
        return { ok: false, snapshotStale: false, message: applied.error ?? 'apply failed' }
      }
      return { ok: true, snapshotStale: false }
    })
  }

  /** Compose a hunk comment (file, line, hunk excerpt, user comment) for the worktree's agent. */
  async hunkComment(
    targetId: string,
    req: { snapshotId: string; file: string; hunkIndex: number; comment: string },
  ): Promise<{ text: string } | null> {
    const diff = await this.diff(targetId, 'wip')
    if (diff.snapshotId !== req.snapshotId) return null
    const file = diff.files.find((f) => f.path === req.file)
    const hunk = file?.hunks[req.hunkIndex]
    if (!file || !hunk) return null
    const excerpt = hunk.text.slice(0, 4000)
    const text = [
      `Review comment on ${file.path} (around line ${hunk.newStart}):`,
      '',
      '```diff',
      excerpt,
      '```',
      '',
      req.comment.slice(0, BOUNDS.maxHunkCommentChars),
    ].join('\n')
    return { text }
  }

  private async evaluateAction(req: PrepareActionRequest): Promise<{
    label: string
    warnings: string[]
    blocked?: string
    key: string
    commits?: Array<{ sha: string; subject: string }>
    commitsTruncated?: boolean
  }> {
    const warnings: string[] = []
    let blocked: string | undefined
    let label = ''
    let commits: Array<{ sha: string; subject: string }> | undefined
    let commitsTruncated: boolean | undefined
    let keyExtra: string[] | undefined

    if (req.action === 'stop') {
      const agent = (await this.discovery.agentTargets()).get(req.targetId)
      if (!agent) throw new TargetNotFoundError(`unknown agent ${req.targetId}`)
      label = `${agent.project}/${agent.name} (${agent.agentKind ?? 'agent'} ${agent.id})`
      if (agent.status === 'working') warnings.push('agent is currently working; stopping interrupts it mid-task')
    } else {
      const wt = (await this.discovery.worktreeTargets()).get(req.targetId)
      if (!wt) throw new TargetNotFoundError(`unknown worktree ${req.targetId}`)
      label = `${wt.project}/${wt.handle} [${wt.branch}]`
      if (req.action === 'remove' && wt.isMain) blocked = 'cannot remove the main worktree'
      if (wt.hasUncommittedChanges && req.action !== 'open') {
        warnings.push('worktree has uncommitted changes')
      }
      if (req.action === 'merge') {
        const base = await git.resolveBase(wt.path).catch(() => null)
        if (!base) blocked = 'base branch not configured for this project; set base_branch in .workmux.yaml'
        else if (base === wt.branch) blocked = 'worktree branch is the base branch'
      }
      if (req.action === 'remove') {
        const base = await git.resolveBase(wt.path).catch(() => null)
        if (base) {
          const status = await git.repoStatus(wt.path).catch(() => null)
          if (status && status.ahead > 0) {
            warnings.push(`branch has ${status.ahead} commit(s) not merged into ${base}`)
          }
        }
      }
      if (req.action === 'close' && !wt.isOpen) blocked = 'worktree window is not open'
      if (req.action === 'open' && wt.isOpen) blocked = 'worktree window is already open'
      if (req.action === 'push') {
        const st = await git.repoStatus(wt.path).catch(() => null)
        if (!st || st.unborn) {
          blocked = 'repository has no commits to push'
        } else if (st.branch === null || st.branch.startsWith('(')) {
          blocked = 'detached HEAD; checkout a branch before pushing'
        } else if (!git.SAFE_REV.test(st.branch)) {
          blocked = 'branch name is not push-safe'
        } else if (!(await git.hasOrigin(wt.path))) {
          blocked = 'no origin remote configured'
        } else {
          const un = await git.unpushedCommits(wt.path, st.branch, BOUNDS.maxPushCommitsList)
          commits = un.commits
          commitsTruncated = un.truncated
          keyExtra = [st.oid, String(un.commits.length), un.ref ?? 'first-push']
          if (un.ref === null && un.commits.length === 0) {
            blocked = 'nothing to push'
          } else if (un.ref !== null && st.ahead === 0 && !st.hasUpstream) {
            blocked = 'nothing to push'
          } else if (un.ref === null) {
            warnings.push(
              (await this.pushCmdForWorktree(req.targetId))
                ? 'no upstream; the configured push command decides how the branch is published'
                : `no upstream; this creates origin/${st.branch} and sets upstream`,
            )
          }
          if (st.hasUpstream && st.ahead === 0) blocked = 'nothing to push — branch is up to date with upstream'
          if (st.hasUpstream && st.behind > 0) {
            warnings.push(`remote has ${st.behind} newer commit(s); push will be rejected until you merge`)
          }
        }
      }
    }

    const key = confirmTokenOf([req.action, req.targetId, label, warnings.join('|'), blocked ?? '', ...(keyExtra ?? [])])
    return { label, warnings, blocked, key, commits, commitsTruncated }
  }

  async prepare(req: PrepareActionRequest): Promise<PreparedAction> {
    const { label, warnings, blocked, key, commits, commitsTruncated } = await this.evaluateAction(req)
    const token = randomBytes(16).toString('hex')
    this.pruneTokens()
    this.issued.set(token, { at: Date.now(), key })
    return {
      action: req.action,
      targetId: req.targetId,
      targetLabel: label,
      requiresConfirmation: true,
      confirmToken: token,
      warnings,
      blocked,
      commits,
      commitsTruncated,
    }
  }

  async execute(
    req: PrepareActionRequest & { confirmToken: string; requestId: string },
  ): Promise<OperationView> {
    const issued = this.issued.get(req.confirmToken)
    if (!issued) throw new ConfirmationError('confirmation expired or invalid; re-confirm the action')
    // Consume synchronously so concurrent executes of the same token cannot both pass.
    this.issued.delete(req.confirmToken)
    // Prune only runs on later prepares; enforce the TTL here too so an old
    // token can never execute without a fresh review.
    if (Date.now() - issued.at > BOUNDS.confirmTokenTtlMs) {
      throw new ConfirmationError('confirmation expired; prepare the action again')
    }
    // Evaluate AFTER acquiring the lock: state may change while queued
    // behind a running operation (audit F03).
    return this.locked(req.targetId, async () => {
      const evaluated = await this.evaluateAction(req)
      if (evaluated.key !== issued.key) {
        throw new ConfirmationError('target state changed since confirmation; review the new warnings')
      }
      if (evaluated.blocked) throw new BadRequestError(evaluated.blocked)
      if (evaluated.warnings.length > 0 && !req.acceptWarnings) {
        throw new ConfirmationError(`unacknowledged warnings: ${evaluated.warnings.join('; ')}`)
      }
      const prepared: PreparedAction = {
        action: req.action,
        targetId: req.targetId,
        targetLabel: evaluated.label,
        requiresConfirmation: true,
        warnings: evaluated.warnings,
        blocked: evaluated.blocked,
      }
      return this.runAction(req.action, prepared, req.acceptWarnings === true)
    })
  }

  private async runAction(
    action: ActionType,
    prepared: PreparedAction,
    acceptWarnings: boolean,
  ): Promise<OperationView> {
    if (action === 'stop') {
      const agent = (await this.discovery.agentTargets()).get(prepared.targetId)
      if (!agent) throw new TargetNotFoundError('agent target disappeared')
      return this.operations.start('stop', prepared.targetLabel, async () => {
        await this.tmux.killPane(agent.id)
        return { output: `stopped ${prepared.targetLabel}` }
      })
    }
    const wt = (await this.discovery.worktreeTargets()).get(prepared.targetId)
    if (!wt) throw new TargetNotFoundError('worktree target disappeared')
    const cwd = wt.projectPath
    const name = `${wt.project}:${wt.handle}`

    switch (action) {
      case 'merge': {
        const base = await git.resolveBase(wt.path)
        return this.operations.start('merge', prepared.targetLabel, async () => {
          const res = await this.workmux.merge({
            cwd,
            name,
            into: base ?? undefined,
            ignoreUncommitted: acceptWarnings,
          })
          const out = `${res.stdout}\n${res.stderr}`.trim()
          if (res.code !== 0) {
            return { output: out, error: /conflict/i.test(out) ? `merge conflict: ${out}` : `merge failed (exit ${res.code}): ${out}` }
          }
          return { output: out }
        })
      }
      case 'push': {
        const st = await git.repoStatus(wt.path).catch(() => null)
        if (!st || st.branch === null || !git.SAFE_REV.test(st.branch)) {
          throw new BadRequestError('branch is not push-safe')
        }
        const setUpstream = !st.hasUpstream
        const cmd = await this.pushCmdForWorktree(prepared.targetId)
        const argv = cmd ? buildPushArgv(cmd, { branch: st.branch, remote: 'origin' }) : null
        return this.operations.start('push', prepared.targetLabel, async () => {
          const res = argv
            ? await git.runPush(wt.path, argv, this.cfg.pushTimeoutMs)
            : await git.push(wt.path, st.branch as string, setUpstream, this.cfg.pushTimeoutMs)
          const out = `${res.stdout}\n${res.stderr}`.trim()
          if (res.code !== 0) return { output: out, error: `push failed (exit ${res.code}): ${out}` }
          return { output: out || 'pushed' }
        })
      }
      case 'remove':
        return this.operations.start('remove', prepared.targetLabel, async () => {
          const res = await this.workmux.remove({ cwd, name, force: acceptWarnings })
          const out = `${res.stdout}\n${res.stderr}`.trim()
          if (res.code !== 0) return { output: out, error: `remove failed (exit ${res.code}): ${out}` }
          return { output: out }
        })
      case 'close':
        return this.operations.start('close', prepared.targetLabel, async () => {
          const res = await this.workmux.close({ cwd, name })
          const out = `${res.stdout}\n${res.stderr}`.trim()
          if (res.code !== 0) return { output: out, error: `close failed (exit ${res.code}): ${out}` }
          return { output: out }
        })
      case 'open':
        return this.operations.start('open', prepared.targetLabel, async () => {
          const res = await this.workmux.open({ cwd, name, background: true })
          const out = `${res.stdout}\n${res.stderr}`.trim()
          if (res.code !== 0) return { output: out, error: `open failed (exit ${res.code}): ${out}` }
          return { output: out }
        })
      default:
        throw new BadRequestError(`unsupported action ${action}`)
    }
  }

  async create(req: CreateWorktreeRequest): Promise<OperationView> {
    const projects = await this.discovery.projects()
    const project = projects.find((p) => p.name === req.project)
    if (!project) throw new TargetNotFoundError(`unknown project ${req.project}`)
    if (!isValidWorktreeName(req.name)) {
      throw new BadRequestError('invalid worktree name (allowed: letters, digits, dot, dash, underscore)')
    }
    if (req.agent && !project.agents.includes(req.agent) && !/^[a-z0-9-]{1,32}$/.test(req.agent)) {
      throw new BadRequestError(`unknown agent profile ${req.agent}`)
    }
    const label = `${project.name}/${req.name}`
    return this.operations.start('create', label, async () => {
      const res = await this.workmux.add({
        cwd: project.path,
        branch: req.name,
        name: req.name,
        prompt: req.prompt,
        agent: req.agent,
        base: req.baseBranch,
      })
      const out = `${res.stdout}\n${res.stderr}`.trim()
      if (res.code !== 0) return { output: out, error: `create failed (exit ${res.code}): ${out}` }
      return { output: out }
    })
  }

  /**
   * Serialize mutations per target. When the job returns an operation view,
   * the lock is held until that operation reaches a terminal state — not
   * released at start (audit F03): a second client's merge cannot begin
   * while the first client's push is still running.
   */
  private locked<T>(targetId: string, job: () => Promise<T>): Promise<T> {
    return this.locks.run(targetId, job)
  }

  private pruneTokens(): void {
    const cutoff = Date.now() - BOUNDS.confirmTokenTtlMs
    for (const [token, entry] of this.issued) {
      if (entry.at < cutoff) this.issued.delete(token)
    }
  }
}

function pieceMatches(piece: string, hunk: { text: string }): boolean {
  const norm = (s: string): string[] => s.split('\n').map((l) => (l === '' ? ' ' : l))
  const hunkBody = norm(hunk.text).slice(1)
  const pieceBody = norm(piece).slice(1)
  if (pieceBody.length === 0 || pieceBody.length >= hunkBody.length) return false
  const counts = new Map<string, number>()
  for (const line of hunkBody) counts.set(line, (counts.get(line) ?? 0) + 1)
  for (const line of pieceBody) {
    const left = counts.get(line) ?? 0
    if (left === 0) return false
    counts.set(line, left - 1)
  }
  return true
}

function toDiffFile(f: ParsedFile): DiffResponse['files'][number] {
  return {
    path: f.path,
    oldPath: f.oldPath ?? undefined,
    status: f.status,
    binary: f.binary,
    additions: f.additions,
    deletions: f.deletions,
    hunks: f.hunks.map((h, index) => ({
      index,
      file: f.path,
      header: h.header,
      oldStart: h.oldStart,
      newStart: h.newStart,
      oldCount: h.oldCount,
      newCount: h.newCount,
      splittable: h.splittable,
      text: h.text,
    })),
    diff: f.diff,
  }
}
