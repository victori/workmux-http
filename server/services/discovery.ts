import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentStatus, AgentView, DashboardSnapshot, GitInfo, ProjectInfo, SourceState, WorktreeView } from '../../shared/types.js'
import type { AppConfig } from '../config.js'
import { BOUNDS } from '../config.js'
import type { TmuxLike, TmuxPane } from '../adapters/tmux.js'
import { DependencyError, type AgentRecord, type WorkmuxLike, type WorktreeRecord } from '../adapters/workmux.js'
import * as git from '../adapters/git.js'
import { worktreeId } from '../targets.js'

const KNOWN_STATUSES: Record<string, true> = { working: true, waiting: true, done: true }

interface CacheEntry<T> {
  at: number
  value: T
  failed: boolean
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
  private prCache = new Map<string, CacheEntry<string | null>>()
  private ghAvailable: boolean | null = null
  private lastGood: LastGood = {}

  constructor(
    private readonly cfg: AppConfig,
    private readonly tmux: TmuxLike,
    private readonly workmux: WorkmuxLike,
  ) {}

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
    for (const w of list ?? []) {
      const id = worktreeId(w.project, w.path)
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
        prUrl: await this.prUrlFor(id, w),
        unpushed: (await this.gitInfoFor(w.path))?.ahead ?? null,
      })
    }

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

  private async prUrlFor(id: string, w: WorktreeRecord): Promise<string | null> {
    if (this.cfg.fixtureDir) return null
    if (this.ghAvailable === null) {
      this.ghAvailable = await git.ghAvailable()
    }
    if (!this.ghAvailable) return null
    const cached = this.prCache.get(id)
    if (cached && Date.now() - cached.at < BOUNDS.prTtlMs) return cached.value
    const url = await git.prUrl(w.path, w.branch)
    this.prCache.set(id, { at: Date.now(), value: url, failed: false })
    return url
  }

  /** Invalidate git-derived caches for one repo after staging/merge operations. */
  invalidateRepo(workdir: string): void {
    this.gitCache.delete(workdir)
  }

  isDependencyError(err: unknown): err is DependencyError {
    return err instanceof DependencyError
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
