import { BOUNDS } from '../config.js'
import type { GithubResolveResult } from '../adapters/git.js'
import { resolveGithubRequest } from '../adapters/git.js'
import type { GithubRequest } from '../adapters/github.js'
import type { Workmux } from '../adapters/workmux.js'
import type { SweepGitFacts, SweepGitLike } from '../adapters/sweep-git.js'
import { confirmTokenOf } from '../targets.js'
import type {
  DashboardSnapshot,
  GithubStatus,
  OperationView,
  PreparedSweep,
  SweepCandidate,
  SweepExecuteRequest,
  SweepItem,
  SweepPrepareRequest,
  SweepScan,
  SweepScanRequest,
  WorktreeView,
} from '../../shared/types.js'
import type { Discovery } from './discovery.js'
import type { GithubStatusService } from './github-status.js'
import type { Operations } from './operations.js'
import type { TargetLocks } from './target-locks.js'
import { BadRequestError, ConfirmationError, TargetNotFoundError } from './management.js'
import { classifySweep, type SweepFacts } from './sweep-policy.js'

export class SweepBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SweepBusyError'
  }
}

export class SnapshotStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotStaleError'
  }
}

export interface RemoveOpts {
  cwd: string
  name: string
  force?: boolean
  keepBranch?: boolean
}

export interface SweepDeps {
  discovery: Discovery
  github: GithubStatusService
  sweepGit: SweepGitLike
  workmux: Pick<Workmux, 'remove'>
  locks: TargetLocks
  operations: Operations
  now?: () => number
  resolveIdentity?: (cwd: string, branch: string | null, headOid: string | null) => Promise<GithubResolveResult>
}

interface FrozenTarget {
  worktreeId: string
  targetLabel: string
  handle: string
  path: string
  view: WorktreeView
  evidenceKey: string
}

interface ScanRecord {
  expiresAt: number
  rows: Map<string, { candidate: SweepCandidate; evidenceKey: string; frozen: FrozenTarget }>
}

interface IssuedSweep {
  expiresAt: number
  targets: FrozenTarget[]
  keepBranches: boolean
  warnings: string[]
}

interface FreshEvidence {
  facts: SweepFacts
  evidenceKey: string
}

const UNSUPPORTED_STATUS: GithubStatus = {
  state: 'unsupported',
  pr: null,
  ci: null,
  observedAt: null,
  attemptedAt: null,
  error: null,
}

function unavailableStatus(error: string): GithubStatus {
  return { state: 'unavailable', pr: null, ci: null, observedAt: null, attemptedAt: Date.now(), error }
}

/** Deterministic drift key: identity + safety evidence, no time, no CI progress. */
function evidenceKey(facts: SweepFacts): string {
  const gh = facts.github
  const ghParts = gh === null ? ['null', ''] : [gh.state, gh.pr ? `${gh.pr.number}:${gh.pr.state}:${gh.pr.headOid}:${gh.pr.headRepository}:${gh.pr.baseRepository}:${gh.pr.baseBranch}` : '']
  return confirmTokenOf([
    facts.worktreeId,
    facts.path ?? '',
    facts.branch ?? '',
    facts.headOid ?? '',
    facts.baseOid ?? '',
    facts.upstream,
    String(facts.mergedIntoBase),
    String(facts.isBase),
    String(facts.isMain),
    String(facts.detached),
    String(facts.unborn),
    String(facts.dirty),
    String(facts.untracked),
    String(facts.conflicts),
    String(facts.operationInProgress),
    String(facts.unsafeRefs),
    String(facts.isOpen),
    facts.liveAgentPaneIds.slice().sort().join(','),
    ...ghParts,
  ])
}

/**
 * Confirmed, non-force clean sweep (design §4–§5).
 *
 * Scan collects evidence into a short-lived server-side record; prepare
 * re-reads everything and binds a single-use token to the exact frozen
 * evidence; execute re-verifies each target under the shared per-worktree
 * lock immediately before `workmux remove` with `force: false`. Nothing is
 * ever retried; ambiguous outcomes stay `unknown`; independent rows keep
 * going past failures.
 */
export class SweepService {
  private readonly scans = new Map<string, ScanRecord>()
  private readonly issued = new Map<string, IssuedSweep>()
  private readonly dedup = new Map<string, { at: number; payloadKey: string; opId: string }>()
  private activeScanId: string | null = null
  private activeSweepId: string | null = null
  private readonly now: () => number
  private readonly resolveIdentity: (cwd: string, branch: string | null, headOid: string | null) => Promise<GithubResolveResult>

  constructor(private readonly deps: SweepDeps) {
    this.now = deps.now ?? Date.now
    this.resolveIdentity = deps.resolveIdentity ?? resolveGithubRequest
  }

  async scan(request: SweepScanRequest): Promise<OperationView> {
    const managed = await this.deps.discovery.worktreeTargets()
    for (const id of request.worktreeIds) {
      if (!managed.has(id)) throw new TargetNotFoundError(`worktree ${id} is not managed`)
    }
    if (this.isRunning(this.activeScanId) || this.isRunning(this.activeSweepId)) {
      throw new SweepBusyError('a sweep scan or sweep is already running')
    }
    let record: ScanRecord | null = null
    const op = this.deps.operations.start('sweep-scan', `scan:${request.worktreeIds.length}`, async () => {
      const rows = await this.collectRows(request.worktreeIds)
      const candidates = rows.map((r) => r.candidate)
      const expiresAt = this.now() + BOUNDS.sweepScanTtlMs
      record = { expiresAt, rows: new Map(rows.map((r) => [r.candidate.worktreeId, r])) }
      const clean = candidates.filter((c) => c.reason !== null && c.blockers.length === 0).length
      return {
        output: `${clean} of ${candidates.length} worktrees are clean to remove`,
        result: { type: 'sweep_scan', candidates, expiresAt } satisfies SweepScan,
      }
    })
    this.activeScanId = op.id
    void this.deps.operations.settled(op.id).then(() => {
      if (record) {
        this.scans.set(op.id, record)
        this.pruneScans()
      }
      if (this.activeScanId === op.id) this.activeScanId = null
    })
    return op
  }

  async prepare(request: SweepPrepareRequest): Promise<PreparedSweep> {
    const record = this.scans.get(request.scanId)
    if (!record || record.expiresAt <= this.now()) {
      throw new SnapshotStaleError('sweep scan expired; rescan before removing worktrees')
    }
    const ids = request.worktreeIds
    const seen = new Set(ids)
    if (seen.size !== ids.length) throw new BadRequestError('duplicate worktree ids in selection')
    for (const id of ids) {
      const row = record.rows.get(id)
      if (!row || row.candidate.reason === null || row.candidate.blockers.length > 0) {
        throw new SnapshotStaleError(`selection changed or contains an ineligible target: ${id}`)
      }
    }
    const frozen: FrozenTarget[] = []
    const candidates: SweepCandidate[] = []
    const warnings = ['Removal deletes the worktree directory, including Git-ignored files.']
    const batch = await this.deps.discovery.snapshot(true)
    for (const id of ids) {
      const scanned = record.rows.get(id)!
      const fresh = await this.collectFresh(id, batch)
      if (!fresh.ok) throw new SnapshotStaleError(`${id}: ${fresh.reason}; rescan required`)
      const candidate = classifySweep(fresh.evidence.facts, request.keepBranches)
      if (candidate.reason === null || candidate.blockers.length > 0) {
        throw new SnapshotStaleError(`${id}: ${candidate.blockers.join('; ') || 'no cleanup evidence'}; rescan required`)
      }
      if (fresh.evidence.evidenceKey !== scanned.evidenceKey) {
        throw new SnapshotStaleError(`${id}: evidence changed since scan; rescan required`)
      }
      if (fresh.evidence.facts.isOpen) {
        warnings.push(`${scanned.frozen.targetLabel}: worktree window is open; remaining panes/processes will be closed`)
      }
      frozen.push({ ...scanned.frozen, evidenceKey: fresh.evidence.evidenceKey })
      candidates.push(candidate)
    }
    if (!request.keepBranches) {
      warnings.push('Local branches for the selected worktrees will be deleted after ancestry proof against the base branch.')
    }
    const token = confirmTokenOf([
      'sweep',
      ...frozen.map((t) => t.evidenceKey),
      request.keepBranches ? 'keep-branches' : 'delete-branches',
    ])
    const expiresAt = this.now() + BOUNDS.confirmTokenTtlMs
    this.issued.set(token, { expiresAt, targets: frozen, keepBranches: request.keepBranches, warnings })
    this.pruneTokens()
    return {
      confirmToken: token,
      expiresAt,
      targets: candidates,
      keepBranches: request.keepBranches,
      warnings,
    }
  }

  execute(request: SweepExecuteRequest): OperationView {
    const payloadKey = confirmTokenOf([request.confirmToken, String(request.acceptWarnings)])
    const existing = this.dedup.get(request.requestId)
    if (existing) {
      if (existing.payloadKey !== payloadKey) {
        throw new BadRequestError('requestId reused with a different payload')
      }
      const op = this.deps.operations.get(existing.opId)
      if (op) return op
    }
    if (this.isRunning(this.activeSweepId)) throw new SweepBusyError('a sweep is already running')
    const entry = this.issued.get(request.confirmToken)
    if (!entry) throw new ConfirmationError('invalid or already-used sweep confirmation token')
    if (entry.expiresAt <= this.now()) {
      this.issued.delete(request.confirmToken)
      throw new ConfirmationError('sweep confirmation expired; prepare again')
    }
    if (entry.warnings.length > 0 && !request.acceptWarnings) {
      throw new ConfirmationError('sweep warnings require acknowledgement')
    }
    this.issued.delete(request.confirmToken)

    const items: SweepItem[] = entry.targets.map((t) => ({
      worktreeId: t.worktreeId,
      targetLabel: t.targetLabel,
      state: 'pending',
      message: null,
    }))
    const report = (): SweepItem[] => items.map((i) => ({ ...i }))
    const op = this.deps.operations.start('sweep', `sweep:${entry.targets.length}`, async (publish) => {
      const emit = (): void => publish({ type: 'sweep', items: report() })
      emit()
      for (let i = 0; i < entry.targets.length; i++) {
        const target = entry.targets[i]!
        const item = items[i]!
        const row = await this.deps.locks.run(target.worktreeId, () => this.executeTarget(target, entry, item, emit))
        item.state = row.state
        item.message = row.message
        emit()
      }
      const summary = summarizeItems(items)
      const state = items.some((i) => i.state === 'unknown')
        ? 'unknown'
        : items.some((i) => i.state !== 'removed')
          ? 'failed'
          : 'done'
      return {
        output: summary,
        error: state === 'done' ? undefined : summary,
        state,
        result: { type: 'sweep', items: report() },
      }
    })
    this.activeSweepId = op.id
    void this.deps.operations.settled(op.id).then(() => {
      if (this.activeSweepId === op.id) this.activeSweepId = null
    })
    this.remember(request.requestId, payloadKey, op.id)
    return op
  }

  private async executeTarget(
    target: FrozenTarget,
    entry: IssuedSweep,
    item: SweepItem,
    emit: () => void,
  ): Promise<SweepItem> {
    const skip = (message: string): SweepItem => ({ ...item, state: 'skipped', message })
    if (entry.expiresAt <= this.now()) return skip('confirmation token expired before this target ran')
    const fresh = await this.collectFresh(target.worktreeId)
    if (!fresh.ok) return skip(fresh.reason)
    const candidate = classifySweep(fresh.evidence.facts, entry.keepBranches)
    if (candidate.blockers.length > 0) return skip(candidate.blockers.join('; '))
    if (fresh.evidence.evidenceKey !== target.evidenceKey) {
      return skip('evidence changed since confirmation; rescan required')
    }

    item.state = 'running'
    emit()
    let code: number
    let stderr = ''
    let truncated = false
    try {
      const res = await this.deps.workmux.remove({
        cwd: fresh.evidence.facts.path ?? target.path,
        name: target.handle,
        force: false,
        keepBranch: entry.keepBranches,
      })
      code = res.code
      stderr = res.stderr
      truncated = res.truncated
    } catch (err) {
      // Process could not be confirmed either way: unknown, never retried.
      const confirmed = await this.confirmRemoval(target, entry.keepBranches)
      return confirmed
        ? { ...item, state: 'removed', message: 'removed (confirmed by postcondition)' }
        : { ...item, state: 'unknown', message: `removal outcome uncertain: ${String(err)}` }
    }
    if (code === 0) {
      const confirmed = await this.confirmRemoval(target, entry.keepBranches)
      return confirmed
        ? { ...item, state: 'removed', message: null }
        : { ...item, state: 'unknown', message: 'removal reported success but postcondition did not confirm' }
    }
    const ambiguous = truncated || code !== 1
    if (ambiguous) {
      const confirmed = await this.confirmRemoval(target, entry.keepBranches)
      return confirmed
        ? { ...item, state: 'removed', message: 'removed (confirmed by postcondition despite ambiguous exit)' }
        : { ...item, state: 'unknown', message: `removal outcome uncertain (exit ${code}${truncated ? ', output truncated' : ''})` }
    }
    return { ...item, state: 'failed', message: stderr.trim() || `workmux remove refused (exit ${code})` }
  }

  private async confirmRemoval(target: FrozenTarget, keepBranches: boolean): Promise<boolean> {
    try {
      return await this.deps.sweepGit.removed(target.view, keepBranches)
    } catch {
      return false
    }
  }

  /**
   * Fresh evidence for one target: git facts, fresh PR read, post-network
   * re-read. `pre` reuses an already-forced discovery snapshot (scan/prepare
   * batches force once per batch); execute passes none so every removal gets
   * its own forced refresh.
   */
  private async collectFresh(id: string, pre?: DashboardSnapshot): Promise<{ ok: true; evidence: FreshEvidence } | { ok: false; reason: string }> {
    const snap = pre ?? (await this.deps.discovery.snapshot(true))
    const wt = snap.worktrees.find((w) => w.id === id)
    if (!wt) return { ok: false, reason: 'target is not managed anymore' }
    if (!this.coreHealthy(snap.sources)) return { ok: false, reason: 'source state is unknown' }
    let facts: SweepGitFacts
    try {
      facts = await this.deps.sweepGit.inspect(wt)
    } catch {
      return { ok: false, reason: 'git inspection failed' }
    }
    let githubStatus: GithubStatus
    if (facts.branch === null || facts.headOid === null) {
      githubStatus = UNSUPPORTED_STATUS
    } else {
      const identity = await this.resolveIdentity(facts.canonicalPath, facts.branch, facts.headOid)
      if (!identity.ok) {
        switch (identity.reason) {
          case 'unsupported':
            githubStatus = UNSUPPORTED_STATUS
            break
          case 'ambiguous':
            githubStatus = unavailableStatus('GitHub remote ambiguous; PR state could not be verified')
            break
          case 'unavailable':
            githubStatus = unavailableStatus(identity.detail)
            break
        }
      } else {
        const request: GithubRequest = { ...identity.request, worktreePath: facts.canonicalPath, headOid: facts.headOid }
        githubStatus = await this.deps.github.fresh(request)
      }
    }
    // Narrow the race: cheap local re-read after the network round-trip.
    const snap2 = await this.deps.discovery.snapshot()
    const wt2 = snap2.worktrees.find((w) => w.id === id)
    if (!wt2) return { ok: false, reason: 'target is not managed anymore' }
    if (!this.coreHealthy(snap2.sources)) return { ok: false, reason: 'source state is unknown' }
    let facts2: SweepGitFacts
    try {
      facts2 = await this.deps.sweepGit.inspect(wt2)
    } catch {
      return { ok: false, reason: 'git inspection failed' }
    }
    if (JSON.stringify(facts) !== JSON.stringify(facts2)) {
      return { ok: false, reason: 'worktree identity changed since scan' }
    }
    const factsF: SweepFacts = {
      worktreeId: id,
      targetLabel: `${wt2.project}/${wt2.handle}`,
      branch: facts2.branch,
      path: facts2.canonicalPath,
      headOid: facts2.headOid,
      baseOid: facts2.baseOid,
      isMain: wt2.isMain,
      isBase: facts2.isBase,
      detached: facts2.detached,
      unborn: facts2.unborn,
      dirty: facts2.dirty,
      untracked: facts2.untracked,
      conflicts: facts2.conflicts,
      operationInProgress: facts2.operationInProgress,
      liveAgentPaneIds: snap2.agents.filter((a) => a.worktreeId === id).map((a) => a.id),
      isOpen: wt2.isOpen,
      healthy: this.coreHealthy(snap2.sources) && snap2.sources.git.ok,
      unsafeRefs: facts2.unsafeRefs,
      identityChanged: false,
      managed: true,
      upstream: facts2.upstream,
      mergedIntoBase: facts2.mergedIntoBase,
      github: githubStatus,
    }
    return { ok: true, evidence: { facts: factsF, evidenceKey: evidenceKey(factsF) } }
  }

  private async collectRows(ids: string[]): Promise<Array<{ candidate: SweepCandidate; evidenceKey: string; frozen: FrozenTarget }>> {
    const out: Array<{ candidate: SweepCandidate; evidenceKey: string; frozen: FrozenTarget }> = []
    const batch = await this.deps.discovery.snapshot(true)
    for (const id of ids) {
      const wt = batch.worktrees.find((w) => w.id === id)
      const fresh = await this.collectFresh(id, batch)
      const frozen: FrozenTarget = {
        worktreeId: id,
        targetLabel: wt ? `${wt.project}/${wt.handle}` : id,
        handle: wt?.handle ?? '',
        path: wt?.path ?? '',
        view: wt ?? { ...({} as WorktreeView) },
        evidenceKey: fresh.ok ? fresh.evidence.evidenceKey : 'unavailable',
      }
      if (!fresh.ok) {
        out.push({
          candidate: { worktreeId: id, targetLabel: frozen.targetLabel, branch: wt?.branch ?? '', path: wt?.path ?? '', reason: null, blockers: [`${fresh.reason}`], warnings: [] },
          evidenceKey: frozen.evidenceKey,
          frozen,
        })
        continue
      }
      const candidate = classifySweep(fresh.evidence.facts, true)
      out.push({ candidate, evidenceKey: fresh.evidence.evidenceKey, frozen })
    }
    return out
  }

  private coreHealthy(sources: { workmuxList: { ok: boolean }; workmuxStatus: { ok: boolean }; tmux: { ok: boolean } }): boolean {
    return sources.workmuxList.ok && sources.workmuxStatus.ok && sources.tmux.ok
  }

  private isRunning(id: string | null): boolean {
    return id !== null && this.deps.operations.get(id)?.state === 'running'
  }

  private remember(requestId: string, payloadKey: string, opId: string): void {
    const cutoff = this.now() - BOUNDS.dedupTtlMs
    for (const [key, value] of this.dedup) {
      if (value.at < cutoff) this.dedup.delete(key)
    }
    while (this.dedup.size >= BOUNDS.dedupMaxEntries) {
      const oldest = this.dedup.keys().next()
      if (oldest.done) break
      this.dedup.delete(oldest.value)
    }
    this.dedup.set(requestId, { at: this.now(), payloadKey, opId })
  }

  private pruneScans(): void {
    const cutoff = this.now() - BOUNDS.sweepScanTtlMs
    for (const [id, record] of this.scans) {
      if (record.expiresAt < cutoff) this.scans.delete(id)
    }
    while (this.scans.size > BOUNDS.sweepMaxStoredScans) {
      const oldest = this.scans.keys().next()
      if (oldest.done) break
      this.scans.delete(oldest.value)
    }
  }

  private pruneTokens(): void {
    const cutoff = this.now() - BOUNDS.confirmTokenTtlMs
    for (const [token, entry] of this.issued) {
      if (entry.expiresAt < cutoff) this.issued.delete(token)
    }
    while (this.issued.size > BOUNDS.sweepMaxStoredTokens) {
      const oldest = this.issued.keys().next()
      if (oldest.done) break
      this.issued.delete(oldest.value)
    }
  }
}

function summarizeItems(items: SweepItem[]): string {
  const count = (s: SweepItem['state']) => items.filter((i) => i.state === s).length
  return `${count('removed')} removed, ${count('skipped')} skipped, ${count('failed')} failed, ${count('unknown')} unknown`
}
