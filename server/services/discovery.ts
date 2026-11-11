import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentStatus, AgentView, DashboardSnapshot, GithubStatus, GitInfo, ProjectInfo, RemoteStatus, SourceState, WorktreeView } from '../../shared/types.js'
import type { AppConfig } from '../config.js'
import { BOUNDS } from '../config.js'
import type { TmuxLike, TmuxPane } from '../adapters/tmux.js'
import { DependencyError, type AgentRecord, type WorkmuxLike, type WorktreeRecord } from '../adapters/workmux.js'
import * as git from '../adapters/git.js'
import type { GithubResolveResult } from '../adapters/git.js'
import type { GithubRequest } from '../adapters/github.js'
import type { GithubStatusService } from './github-status.js'
import { worktreeId } from '../targets.js'

const KNOWN_STATUSES: Record<string, true> = { working: true, waiting: true, done: true }

interface CacheEntry<T> {
  at: number
  value: T
  failed: boolean
}

interface GithubIdentityEntry {
  branch: string
  result: GithubResolveResult | null
  refreshAt: number
  error: string | null
}

interface LastGood {
  list?: WorktreeRecord[]
  agents?: AgentRecord[]
  panes?: TmuxPane[]
}

/**
 * Builds and caches dashboard snapshots. Sources are workmux JSON plus
 * structured tmux queries; failures degrade to the last good data with an
 * explicit error/stale marker instead of fabricated empties.
 */
export class Discovery {
  private cache: DashboardSnapshot | null = null
  private inflight: Promise<DashboardSnapshot> | null = null
  private gitCache = new Map<string, CacheEntry<GitInfo | null>>()
  private identityCache = new Map<string, GithubIdentityEntry>()
  private lastGood: LastGood = {}
  private readonly githubSvc: GithubStatusService | null

  constructor(
    private readonly cfg: AppConfig,
    private readonly tmux: TmuxLike,
    private readonly workmux: WorkmuxLike,
    github: GithubStatusService | null = null,
  ) {
    this.githubSvc = github
  }

  snapshot(force = false): Promise<DashboardSnapshot> {
    if (!force && this.cache && Date.now() - this.cache.observedAt < BOUNDS.coreTtlMs) {
      return Promise.resolve(this.cache)
    }
    if (!force && this.inflight) return this.inflight
    const job = this.build()
      .then((snap) => {
        this.cache = snap
        return snap
      })
      .finally(() => {
        if (this.inflight === job) this.inflight = null
      })
    this.inflight = job
    return job
  }

  /** Managed-only enforcement: agent pane ids from the latest snapshot. */
  async agentTargets(): Promise<Map<string, AgentView>> {
    const snap = await this.snapshot()
    return new Map(snap.agents.map((a) => [a.id, a]))
  }

  async worktreeTargets(): Promise<Map<string, WorktreeView>> {
    const snap = await this.snapshot()
    return new Map(snap.worktrees.map((w) => [w.id, w]))
  }

  async projects(): Promise<ProjectInfo[]> {
    const snap = await this.snapshot()
    const byPath = new Map<string, ProjectInfo>()
    const add = (name: string, repoPath: string) => {
      if (!repoPath || byPath.has(name)) return
      byPath.set(name, { name, path: repoPath, baseBranch: null, agents: [], hasConfig: false })
    }
    for (const w of snap.worktrees) add(w.project, w.projectPath)
    for (const repo of this.cfg.repos) add(path.basename(repo), repo)

    for (const p of byPath.values()) {
      p.hasConfig = await access(`${p.path}/.workmux.yaml`)
        .then(() => true)
        .catch(() => false)
      p.baseBranch = await git.resolveBase(p.path).catch(() => null)
      const kinds = new Set(
        snap.agents.filter((a) => a.projectPath === p.path && a.agentKind).map((a) => a.agentKind as string),
      )
      p.agents = [...kinds].sort()
    }
    return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async build(): Promise<DashboardSnapshot> {
    const now = Date.now()
    const sources: DashboardSnapshot['sources'] = {
      workmuxList: { ok: true, at: now },
      workmuxStatus: { ok: true, at: now },
      tmux: { ok: true, at: now },
      git: { ok: true, at: now },
    }
    let list: WorktreeRecord[] | undefined
    let agents: AgentRecord[] | undefined
    let panes: TmuxPane[] | undefined
    let gitDegraded = false

    if (this.cfg.fixtureDir) {
      const fx = this.cfg.fixtureDir
      const load = async (name: string): Promise<unknown> =>
        JSON.parse(await readFile(path.join(fx, name), 'utf8'))
      list = (await load('list-all.json').catch(() => null)) as WorktreeRecord[] | null ?? undefined
      const statusPayload = (await load('status-all.json').catch(() => null)) as
        | { agents?: AgentRecord[] }
        | null
      agents = statusPayload?.agents ?? undefined
      if (!list) sources.workmuxList = { ok: false, error: 'fixture list-all.json missing', at: now }
      if (!agents) sources.workmuxStatus = { ok: false, error: 'fixture status-all.json missing', at: now }
      panes = (agents ?? []).map((a) => ({
        paneId: a.pane_id,
        sessionName: a.session,
        sessionId: `$${a.session}`,
        windowIndex: 0,
        windowName: a.window_name ?? '',
        paneIndex: 0,
        paneActive: true,
        currentCommand: a.agent_kind ?? '',
        width: 80,
        height: 24,
        dead: false,
        owned: false,
      }))
    } else {
      const [listRes, statusRes, panesRes, sessions] = await Promise.allSettled([
        this.workmux.listAll(),
        this.workmux.statusAll(),
        this.tmux.listPanes(),
        this.tmux.listSessions(),
      ])
      if (listRes.status === 'fulfilled') {
        list = listRes.value
        this.lastGood.list = list
      } else {
        list = this.lastGood.list
        sources.workmuxList = { ok: false, error: errorMessage(listRes.reason), at: now }
      }
      if (statusRes.status === 'fulfilled') {
        agents = statusRes.value.agents
        this.lastGood.agents = agents
      } else {
        agents = this.lastGood.agents
        sources.workmuxStatus = { ok: false, error: errorMessage(statusRes.reason), at: now }
      }
      if (panesRes.status === 'fulfilled') {
        panes = panesRes.value
        this.lastGood.panes = panes
      } else {
        panes = this.lastGood.panes ?? []
        sources.tmux = { ok: false, error: errorMessage(panesRes.reason), at: now }
      }
      const owned = new Set((sessions.status === 'fulfilled' ? sessions.value : []).filter((s) => s.owned).map((s) => s.name))
      panes = (panes ?? []).filter((p) => !owned.has(p.sessionName))
    }

    const paneById = new Map((panes ?? []).map((p) => [p.paneId, p]))

    const agentViews: AgentView[] = []
    for (const a of agents ?? []) {
      const pane = paneById.get(a.pane_id)
      if (!pane || pane.dead) continue
      // workmux registers any project-window pane as an agent record;
      // kind-less ones are plain shells (dev servers, zsh) — not agents.
      if (!a.agent_kind) continue
      const project = a.project ?? path.basename(a.workdir)
      const projectPath = a.project_path ?? a.workdir
      const raw: AgentStatus = a.status in KNOWN_STATUSES ? (a.status as AgentStatus) : 'stale'
      const status: AgentStatus =
        raw === 'stale' || (a.elapsed_secs ?? 0) > this.cfg.staleAfterSecs ? 'stale' : raw
      const gitInfo = await this.gitInfoFor(a.workdir)
      if (gitInfo === undefined) gitDegraded = true
      agentViews.push({
        id: a.pane_id,
        name: a.worktree,
        project,
        projectPath,
        worktreeId: worktreeId(project, a.workdir),
        status,
        elapsedSecs: a.elapsed_secs ?? 0,
        title: a.title ?? null,
        agentKind: a.agent_kind ?? null,
        session: a.session,
        windowName: a.window_name ?? null,
        workdir: a.workdir,
        git: gitInfo ?? null,
        updatedTs: a.updated_ts,
      })
    }

    const worktreeViews: WorktreeView[] = []
    const githubRequests: GithubRequest[] = []
    const fixtureGithub = this.cfg.fixtureDir ? await loadFixtureGithub(this.cfg.fixtureDir) : null
    const fixtureRemotes = this.cfg.fixtureDir ? await loadFixtureRemotes(this.cfg.fixtureDir) : null
    for (const w of list ?? []) {
      const id = worktreeId(w.project, w.path)
      const gi = await this.gitInfoFor(w.path)
      if (gi === undefined) gitDegraded = true
      const github = this.githubFor(id, w, gi, githubRequests, fixtureGithub)
      const remoteBranch = gi && !gi.unborn && gi.branch && !gi.branch.startsWith('(') ? gi.branch : null
      const remotes = this.cfg.fixtureDir
        ? fixtureRemotes?.get(id)
        : remoteBranch
          ? await git.remoteStatuses(w.path, remoteBranch, BOUNDS.maxRemotesPerRepo).catch(() => undefined)
          : undefined
      worktreeViews.push({
        id,
        project: w.project,
        projectPath: w.project_path,
        handle: w.handle,
        branch: w.branch,
        path: w.path,
        isMain: w.is_main,
        mode: w.mode,
        hasUncommittedChanges: w.has_uncommitted_changes,
        isOpen: w.is_open,
        agentStatuses: w.agent_statuses.map((s) =>
          s in KNOWN_STATUSES ? (s as AgentStatus) : 'stale',
        ),
        createdAt: w.created_at,
        prUrl: github?.state === 'ready' && github.pr ? github.pr.url : null,
        unpushed: gi?.ahead ?? null,
        remotes,
        github,
      })
    }
    this.githubSvc?.retain(githubRequests)

    const anyFailed = Object.values(sources).some((s) => !s.ok)
    if (gitDegraded) sources.git = { ok: false, error: 'one or more git status calls failed', at: now }
    const stale = anyFailed || gitDegraded || this.agentsAreStale(agentViews)

    return {
      observedAt: now,
      agents: agentViews,
      worktrees: worktreeViews,
      sources,
      stale,
    }
  }

  private agentsAreStale(agents: AgentView[]): boolean {
    return agents.some((a) => Date.now() / 1000 - a.updatedTs > this.cfg.staleAfterSecs)
  }

  /** null = unavailable (not fabricated); undefined = source failure this cycle. */
  private async gitInfoFor(workdir: string): Promise<GitInfo | null | undefined> {
    if (this.cfg.fixtureDir) return null
    const cached = this.gitCache.get(workdir)
    if (cached && Date.now() - cached.at < BOUNDS.gitTtlMs) {
      return cached.failed ? undefined : cached.value
    }
    try {
      if (!(await git.isRepo(workdir))) {
        this.gitCache.set(workdir, { at: Date.now(), value: null, failed: false })
        return null
      }
      const st = await git.repoStatus(workdir)
      const info: GitInfo = {
        branch: st.branch,
        headOid: /^[0-9a-f]{40}$/.test(st.oid) ? st.oid : null,
        hasStaged: st.hasStaged,
        hasUnstaged: st.hasUnstaged,
        hasUnmergedCommits: st.ahead > 0,
        unborn: st.unborn,
        ahead: st.hasUpstream || st.upstreamAssumed ? st.ahead : null,
        behind: st.hasUpstream || st.upstreamAssumed ? st.behind : null,
        pendingChanges: st.pendingChanges,
      }
      this.gitCache.set(workdir, { at: Date.now(), value: info, failed: false })
      return info
    } catch {
      this.gitCache.set(workdir, { at: Date.now(), value: null, failed: true })
      return undefined
    }
  }

  /**
   * GitHub status for one worktree: fixture data in fixture mode; otherwise
   * a non-blocking cache view keyed on the resolved repo/branch/HEAD identity.
   * Requests are collected for `retain` so the service prunes departed keys.
   */
  private githubFor(
    id: string,
    w: WorktreeRecord,
    gi: GitInfo | null | undefined,
    githubRequests: GithubRequest[],
    fixtureGithub: Map<string, GithubStatus> | null,
  ): GithubStatus | undefined {
    if (this.cfg.fixtureDir) {
      return fixtureGithub?.get(id) ?? unavailableGithub('no fixture GitHub status')
    }
    if (!this.githubSvc) return undefined
    const branch = gi?.branch ?? w.branch
    if (!branch || !gi?.headOid) {
      return { state: 'unsupported', pr: null, ci: null, observedAt: null, attemptedAt: null, error: null }
    }
    const entry = this.identityCache.get(w.path)
    const cached = entry?.branch === branch ? entry : undefined
    const expired = !cached || Date.now() >= cached.refreshAt
    if (expired) {
      const pending = { branch, result: cached?.result ?? null, refreshAt: Infinity, error: cached?.error ?? null }
      this.identityCache.set(w.path, pending)
      void git
        .resolveGithubRequest(w.path, branch, gi.headOid)
        .catch(() => ({ ok: false, reason: 'unavailable', detail: 'cannot resolve GitHub remote' }) as const)
        .then((result) => {
          if (this.identityCache.get(w.path) === pending) {
            const error = !result.ok && result.reason === 'unavailable' ? result.detail : null
            this.identityCache.set(w.path, {
              branch,
              result: error ? pending.result : result,
              refreshAt: Date.now() + BOUNDS.githubIdentityTtlMs,
              error,
            })
          }
        })
    }
    if (!cached) return undefined
    const { result, error, refreshAt } = cached
    if (!result?.ok) {
      if (error) return unavailableGithub(error)
      if (!result) return undefined
      return result.reason === 'ambiguous'
        ? unavailableGithub('GitHub remote ambiguous: multiple GitHub remotes configured')
        : { state: 'unsupported', pr: null, ci: null, observedAt: null, attemptedAt: null, error: null }
    }
    const request = { ...result.request, headOid: gi.headOid }
    githubRequests.push(request)
    const status = this.githubSvc.view(request, !expired && refreshAt !== Infinity && !error)
    if (!error) return status
    return status.state === 'ready' || status.state === 'stale'
      ? { ...status, state: 'stale', error }
      : unavailableGithub(error)
  }

  /** Invalidate git-derived caches for one repo after staging/merge operations. */
  invalidateRepo(workdir: string): void {
    this.gitCache.delete(workdir)
    const identity = this.identityCache.get(workdir)
    if (identity) this.identityCache.set(workdir, { ...identity, refreshAt: 0 })
  }

  isDependencyError(err: unknown): err is DependencyError {
    return err instanceof DependencyError
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unavailableGithub(error: string): GithubStatus {
  return { state: 'unavailable', pr: null, ci: null, observedAt: null, attemptedAt: Date.now(), error }
}

/** Fixture GitHub statuses keyed by worktree id; missing file = no entries. */
async function loadFixtureGithub(fixtureDir: string): Promise<Map<string, GithubStatus>> {
  try {
    const raw = JSON.parse(await readFile(path.join(fixtureDir, 'github-status.json'), 'utf8')) as Record<string, unknown>
    const out = new Map<string, GithubStatus>()
    for (const [id, value] of Object.entries(raw)) {
      if (value && typeof value === 'object' && typeof (value as { state?: unknown }).state === 'string') {
        out.set(id, value as GithubStatus)
      }
    }
    return out
  } catch {
    return new Map()
  }
}

/** Fixture per-remote statuses keyed by worktree id; missing file = no entries. */
async function loadFixtureRemotes(fixtureDir: string): Promise<Map<string, RemoteStatus[]>> {
  try {
    const raw = JSON.parse(await readFile(path.join(fixtureDir, 'remotes.json'), 'utf8')) as Record<string, unknown>
    const out = new Map<string, RemoteStatus[]>()
    for (const [id, value] of Object.entries(raw)) {
      if (Array.isArray(value) && value.every((r) => r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string')) {
        out.set(id, value as RemoteStatus[])
      }
    }
    return out
  } catch {
    return new Map()
  }
}
