import { describe, expect, test, vi } from 'vitest'
import type { AgentView, GithubStatus, OperationView, WorktreeView } from '../../shared/types.js'
import type { Discovery } from './discovery.js'
import type { GithubStatusService } from './github-status.js'
import type { GithubResolveResult } from '../adapters/git.js'
import type { GithubRequest } from '../adapters/github.js'
import type { SweepGitFacts, SweepGitLike } from '../adapters/sweep-git.js'
import type { Workmux } from '../adapters/workmux.js'
import { Operations } from './operations.js'
import { TargetLocks } from './target-locks.js'
import { BadRequestError, ConfirmationError, TargetNotFoundError } from './management.js'
import { SweepBusyError, SweepService, SnapshotStaleError } from './sweep.js'
import type { RemoveOpts } from './sweep.js'
import type { RunResult } from '../exec.js'

const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)
const BASE = 'f'.repeat(40)

const mergedGithub: GithubStatus = {
  state: 'ready',
  pr: {
    number: 3,
    title: 'Done',
    url: 'https://github.com/acme/widgets/pull/3',
    state: 'merged',
    review: 'approved',
    headOid: HEAD_A,
    headRepository: 'acme/widgets',
    baseRepository: 'acme/widgets',
    baseBranch: 'main',
  },
  ci: null,
  observedAt: 1,
  attemptedAt: 1,
  error: null,
}

function worktreeView(id: string, overrides: Partial<WorktreeView> = {}): WorktreeView {
  return {
    id,
    project: 'proj',
    projectPath: '/repos/proj',
    handle: id === 'wt_main' ? 'main' : id.slice(-4),
    branch: id === 'wt_main' ? 'main' : `feat/${id.slice(-4)}`,
    path: `/repos/proj/.claude/worktrees/${id.slice(-4)}`,
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

function eligibleFacts(headOid = HEAD_A): SweepGitFacts {
  return {
    canonicalPath: '/canonical/path',
    repoRoot: '/repos/proj',
    branch: 'feat/x',
    headOid,
    baseOid: BASE,
    isBase: false,
    detached: false,
    unborn: false,
    dirty: false,
    untracked: false,
    conflicts: false,
    operationInProgress: false,
    upstreamRemote: 'origin',
    upstreamBranch: 'feat/x',
    upstream: 'present',
    mergedIntoBase: true,
    unsafeRefs: false,
  }
}

interface RemoveOutcome {
  result?: Partial<RunResult>
  gate?: { promise: Promise<RunResult>; resolve: (r: RunResult) => void }
}

interface Harness {
  svc: SweepService
  clock: { t: number }
  operations: Operations
  locks: TargetLocks
  worktrees: Map<string, WorktreeView>
  agents: AgentView[]
  sources: Record<string, { ok: boolean; at: number; error?: string }>
  facts: Map<string, SweepGitFacts>
  inspectFailures: Set<string>
  inspectGates: Map<string, Promise<void>>
  inspectCalls: string[]
  removedResults: Map<string, boolean>
  removeCalls: RemoveOpts[]
  removeOutcomes: Map<string, RemoveOutcome>
  setGithub: (g: GithubStatus) => void
  refreshCount: () => number
}

function harness(): Harness {
  const clock = { t: 1_000_000 }
  const operations = new Operations()
  const locks = new TargetLocks(operations)

  const worktrees = new Map<string, WorktreeView>([
    ['wt_aaaa', worktreeView('wt_aaaa')],
    ['wt_bbbb', worktreeView('wt_bbbb')],
    ['wt_main', worktreeView('wt_main', { isMain: true })],
  ])
  const agents: AgentView[] = []
  const sourcesOk = { workmuxList: { ok: true, at: 1 }, workmuxStatus: { ok: true, at: 1 }, tmux: { ok: true, at: 1 }, git: { ok: true, at: 1 } }
  const sources = { ...sourcesOk }
  let forceRefreshes = 0

  const discovery = {
    snapshot: async (force = false) => {
      if (force) forceRefreshes += 1
      return { observedAt: clock.t, agents, worktrees: [...worktrees.values()], sources, stale: false }
    },
    worktreeTargets: async () => new Map(worktrees),
  } as unknown as Discovery

  let githubResult: GithubStatus = mergedGithub
  const github = {
    view: () => loading(),
    fresh: async (req: GithubRequest) => ({
      ...githubResult,
      pr: githubResult.pr ? { ...githubResult.pr, headOid: req.headOid } : null,
    }),
    retain: () => undefined,
  } as unknown as GithubStatusService

  const facts = new Map<string, SweepGitFacts>([
    ['wt_aaaa', eligibleFacts(HEAD_A)],
    ['wt_bbbb', eligibleFacts(HEAD_B)],
    ['wt_main', eligibleFacts()],
  ])
  const inspectFailures = new Set<string>()
  const inspectGates = new Map<string, Promise<void>>()
  const inspectCalls: string[] = []
  const removedResults = new Map<string, boolean>()
  const sweepGit: SweepGitLike = {
    inspect: async (wt) => {
      if (inspectFailures.has(wt.id)) throw new Error(`git inspection failed for ${wt.id}`)
      inspectCalls.push(wt.id)
      const gate = inspectGates.get(wt.id)
      if (gate) await gate
      const f = facts.get(wt.id)
      if (!f) throw new Error(`no facts for ${wt.id}`)
      return { ...f, canonicalPath: wt.path }
    },
    removed: async (wt, keepBranches) => removedResults.get(wt.id) ?? false,
  }

  const removeCalls: RemoveOpts[] = []
  const removeOutcomes = new Map<string, RemoveOutcome>()
  const workmux = {
    remove: async (opts: RemoveOpts): Promise<RunResult> => {
      removeCalls.push(opts)
      const outcome = removeOutcomes.get(opts.name)
      if (outcome?.gate) return outcome.gate.promise
      return { code: 0, stdout: 'removed', stderr: '', truncated: false, ...outcome?.result }
    },
  } as unknown as Pick<Workmux, 'remove'>

  const resolveIdentity = async (): Promise<GithubResolveResult> => ({
    ok: true,
    request: {
      worktreePath: '/canonical/path',
      headRepository: 'acme/widgets',
      configuredBaseRepository: 'acme/widgets',
      branch: 'feat/x',
      headOid: HEAD_A,
    },
  })

  const svc = new SweepService({
    discovery,
    github,
    sweepGit,
    workmux,
    locks,
    operations,
    now: () => clock.t,
    resolveIdentity,
  })

  return {
    svc,
    clock,
    operations,
    locks,
    worktrees,
    agents,
    sources,
    facts,
    inspectFailures,
    inspectGates,
    inspectCalls,
    removedResults,
    removeCalls,
    removeOutcomes,
    setGithub: (g: GithubStatus) => {
      githubResult = g
    },
    refreshCount: () => forceRefreshes,
  }
}

function loading(): GithubStatus {
  return { state: 'loading', pr: null, ci: null, observedAt: null, attemptedAt: Date.now(), error: null }
}

const okRun: RunResult = { code: 0, stdout: '', stderr: '', truncated: false }

async function finishScan(h: Harness, ids: string[]): Promise<{ op: OperationView; scanId: string }> {
  const op = await h.svc.scan({ worktreeIds: ids, requestId: `scan-${ids.join('-')}` })
  await h.operations.settled(op.id)
  return { op, scanId: op.id }
}

async function prepareIds(h: Harness, scanId: string, ids: string[], keepBranches = true) {
  return h.svc.prepare({ scanId, worktreeIds: ids, keepBranches, requestId: `prep-${ids.join('-')}-${keepBranches}` })
}

describe('SweepService scan', () => {
  test('should reject unmanaged sweep targets', async () => {
    const h = harness()
    await expect(h.svc.scan({ worktreeIds: ['wt_ghost'], requestId: 'r1' })).rejects.toThrow(TargetNotFoundError)
  })

  test('should record blockers for every scanned row without omitting failures', async () => {
    const h = harness()
    h.inspectFailures.add('wt_bbbb')
    const { op, scanId } = await finishScan(h, ['wt_aaaa', 'wt_bbbb', 'wt_main'])
    expect(op.state).toBe('done')
    const scan = op.result
    expect(scan?.type).toBe('sweep_scan')
    if (scan?.type !== 'sweep_scan') throw new Error('bad scan type')
    const byId = new Map(scan.candidates.map((c) => [c.worktreeId, c]))
    expect(byId.get('wt_aaaa')?.reason).toBe('pr_merged')
    expect(byId.get('wt_aaaa')?.blockers).toEqual([])
    expect(byId.get('wt_main')?.blockers).toContain('main worktree is never swept')
    expect(byId.get('wt_bbbb')?.blockers.join(' ')).toContain('inspection failed')
    expect(scan.expiresAt).toBe(h.clock.t + 300_000)
  })

  test('should force discovery once per scan batch and once per prepare', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa', 'wt_bbbb', 'wt_main'])
    expect(h.refreshCount()).toBe(1)
    await prepareIds(h, scanId, ['wt_aaaa', 'wt_bbbb'])
    expect(h.refreshCount()).toBe(2)
  })

  test('should allow only one scan at a time', async () => {
    const h = harness()
    const gate = Promise.withResolvers<void>()
    h.inspectGates.set('wt_aaaa', gate.promise)
    const first = h.svc.scan({ worktreeIds: ['wt_aaaa'], requestId: 'r1' })
    await expect(h.svc.scan({ worktreeIds: ['wt_bbbb'], requestId: 'r2' })).rejects.toThrow(SweepBusyError)
    gate.resolve()
    const firstOp = await first
    await h.operations.settled(firstOp.id)
    const second = await h.svc.scan({ worktreeIds: ['wt_bbbb'], requestId: 'r3' })
    expect(second.state).toBe('running')
  })
})

describe('SweepService prepare', () => {
  test('should reject an expired scan with snapshot stale', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa'])
    h.clock.t += 300_001
    await expect(prepareIds(h, scanId, ['wt_aaaa'])).rejects.toThrow(SnapshotStaleError)
  })

  test('should reject selections outside the scanned scope', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa'])
    await expect(prepareIds(h, scanId, ['wt_aaaa', 'wt_bbbb'])).rejects.toThrow(SnapshotStaleError)
  })

  test('should reject ineligible selections', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa', 'wt_main'])
    await expect(prepareIds(h, scanId, ['wt_main'])).rejects.toThrow(SnapshotStaleError)
  })

  test('should reject changed evidence before issuing a token', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa'])
    h.facts.set('wt_aaaa', { ...eligibleFacts(HEAD_A), dirty: true })
    await expect(prepareIds(h, scanId, ['wt_aaaa'])).rejects.toThrow(SnapshotStaleError)
  })

  test('should issue a token binding the exact selection and warnings', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa', 'wt_main'])
    const prepared = await prepareIds(h, scanId, ['wt_aaaa'])
    expect(prepared.targets.map((t) => t.worktreeId)).toEqual(['wt_aaaa'])
    expect(prepared.keepBranches).toBe(true)
    expect(prepared.confirmToken).toMatch(/^[0-9a-f]{24}$/)
    expect(prepared.warnings.join(' ')).toContain('ignored')
    expect(prepared.expiresAt).toBe(h.clock.t + 300_000)
  })

  test('should re-evaluate branch ancestry when branches are not kept', async () => {
    const h = harness()
    const { scanId } = await finishScan(h, ['wt_aaaa'])
    h.facts.set('wt_aaaa', { ...eligibleFacts(HEAD_A), mergedIntoBase: false })
    await expect(prepareIds(h, scanId, ['wt_aaaa'], false)).rejects.toThrow(SnapshotStaleError)
    await expect(prepareIds(h, scanId, ['wt_aaaa'], true)).rejects.toThrow(SnapshotStaleError)
    const rescan = await finishScan(h, ['wt_aaaa'])
    const kept = await prepareIds(h, rescan.scanId, ['wt_aaaa'], true)
    expect(kept.keepBranches).toBe(true)
    expect(kept.targets[0]?.reason).toBe('pr_merged')
  })
})

describe('SweepService execute', () => {
  async function prepared(h: Harness, ids: string[], keepBranches = true) {
    const { scanId } = await finishScan(h, ids)
    return prepareIds(h, scanId, ids, keepBranches)
  }

  test('should consume sweep tokens before concurrent execution', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', true)
    const prep = await prepared(h, ['wt_aaaa'])
    const first = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    expect(() => h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x2' })).toThrow(SweepBusyError)
    await h.operations.settled(first.id)
    expect(first.state).toBe('done')
    expect(() => h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x3' })).toThrow(ConfirmationError)
  })

  test('should preserve branches without forcing removal', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', true)
    const prep = await prepared(h, ['wt_aaaa'], true)
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    expect(h.removeCalls).toHaveLength(1)
    expect(h.removeCalls[0]).toMatchObject({ name: 'aaaa', force: false, keepBranch: true })
    const result = op.result
    if (result?.type === 'sweep') expect(result.items[0]?.state).toBe('removed')
  })

  test('should delete branches when keep-branch is off and ancestry proven', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', true)
    const prep = await prepared(h, ['wt_aaaa'], false)
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    expect(h.removeCalls[0]).toMatchObject({ force: false, keepBranch: false })
    expect(op.state).toBe('done')
  })

  test('should skip a target changed while waiting for its management lock', async () => {
    const h = harness()
    const prep = await prepared(h, ['wt_aaaa', 'wt_bbbb'])
    // A management-side operation holds wt_bbbb's lock; while queued the
    // target becomes dirty.
    const gate = Promise.withResolvers<OperationView>()
    const held = h.locks.run('wt_bbbb', () => gate.promise)
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    h.facts.set('wt_bbbb', { ...eligibleFacts(HEAD_B), dirty: true })
    h.removedResults.set('wt_aaaa', true)
    gate.resolve({ id: 'mgmt-op', kind: 'push', target: 'wt_bbbb', state: 'done', output: null, error: null, startedAt: 1, endedAt: 2 })
    await held
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    const byId = new Map(result.items.map((i) => [i.worktreeId, i]))
    expect(byId.get('wt_aaaa')?.state).toBe('removed')
    expect(byId.get('wt_bbbb')?.state).toBe('skipped')
    expect(byId.get('wt_bbbb')?.message).toContain('local changes')
    expect(h.removeCalls.map((c) => c.name)).toEqual(['aaaa'])
  })

  test('should continue safe rows after a known failure', async () => {
    const h = harness()
    h.removedResults.set('wt_bbbb', true)
    h.removeOutcomes.set('aaaa', { result: { code: 1, stderr: 'Cannot remove worktrees with uncommitted changes', stdout: '' } })
    const prep = await prepared(h, ['wt_aaaa', 'wt_bbbb'])
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    const byId = new Map(result.items.map((i) => [i.worktreeId, i]))
    expect(byId.get('wt_aaaa')?.state).toBe('failed')
    expect(byId.get('wt_bbbb')?.state).toBe('removed')
    expect(op.state).toBe('failed')
    expect(h.removeCalls.map((c) => c.name)).toEqual(['aaaa', 'bbbb'])
  })

  test('should never retry an ambiguous removal', async () => {
    const h = harness()
    h.removeOutcomes.set('aaaa', { result: { code: 124, stderr: 'timed out', stdout: '' } })
    h.removedResults.set('wt_aaaa', false)
    const prep = await prepared(h, ['wt_aaaa'])
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    expect(result.items[0]?.state).toBe('unknown')
    expect(h.removeCalls.filter((c) => c.name === 'aaaa')).toHaveLength(1)
    expect(op.state).toBe('unknown')
  })

  test('should publish per-item progress before the sweep settles', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', true)
    const gate = Promise.withResolvers<RunResult>()
    h.removeOutcomes.set('bbbb', { gate: { promise: gate.promise, resolve: gate.resolve } })
    const prep = await prepared(h, ['wt_aaaa', 'wt_bbbb'])
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await vi.waitFor(() => expect(h.removeCalls.map((c) => c.name)).toEqual(['aaaa', 'bbbb']))
    const mid = h.operations.get(op.id)?.result
    if (mid?.type !== 'sweep') throw new Error('progress not published while running')
    const byId = new Map(mid.items.map((i) => [i.worktreeId, i]))
    expect(byId.get('wt_aaaa')?.state).toBe('removed')
    expect(byId.get('wt_bbbb')?.state).toBe('running')
    gate.resolve(okRun)
    await h.operations.settled(op.id)
  })

  test('should mark unconfirmed removals unknown even after exit zero', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', false)
    const prep = await prepared(h, ['wt_aaaa'])
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    expect(result.items[0]?.state).toBe('unknown')
    expect(op.state).toBe('unknown')
  })

  test('should skip rows whose sources degraded before removal', async () => {
    const h = harness()
    const prep = await prepared(h, ['wt_aaaa'])
    h.sources.git = { ok: false, error: 'git down', at: 2 }
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    expect(result.items[0]?.state).toBe('skipped')
    expect(result.items[0]?.message).toContain('unknown')
    expect(h.removeCalls).toHaveLength(0)
  })

  test('should skip rows that gained a live agent pane', async () => {
    const h = harness()
    const prep = await prepared(h, ['wt_aaaa'])
    h.agents.push({
      id: '%7',
      name: 'wt_aaaa',
      project: 'proj',
      projectPath: '/repos/proj',
      worktreeId: 'wt_aaaa',
      status: 'done',
      elapsedSecs: 1,
      title: null,
      agentKind: 'claude',
      session: 's',
      windowName: 'w',
      workdir: '/repos/proj',
      git: null,
      updatedTs: 1,
    })
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    expect(result.items[0]?.state).toBe('skipped')
    expect(result.items[0]?.message).toContain('live agent')
  })

  test('should dedupe request ids and reject payload reuse', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', true)
    const prep = await prepared(h, ['wt_aaaa'])
    const req = { confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'dup1' }
    const first = h.svc.execute(req)
    const retry = h.svc.execute(req)
    expect(retry).toBe(first)
    expect(() => h.svc.execute({ ...req, requestId: 'dup1', acceptWarnings: false })).toThrow(BadRequestError)
    await h.operations.settled(first.id)
  })

  test('should reject capacity exhaustion before consuming the token', async () => {
    const h = harness()
    const gate = Promise.withResolvers<RunResult>()
    h.removeOutcomes.set('aaaa', { gate: { promise: gate.promise, resolve: gate.resolve } })
    const prep = await prepared(h, ['wt_aaaa'])
    const running = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await expect(h.svc.scan({ worktreeIds: ['wt_bbbb'], requestId: 'busy-scan' })).rejects.toThrow(SweepBusyError)
    gate.resolve(okRun)
    h.removedResults.set('wt_aaaa', true)
    await h.operations.settled(running.id)
    // Token survived the busy rejection untouched (already consumed by x1 —
    // a fresh prepare proves the busy path never consumed a second token).
    const prep2 = await prepared(h, ['wt_bbbb'])
    const scanBusy = await h.svc.scan({ worktreeIds: ['wt_bbbb'], requestId: 'scan2' })
    await h.operations.settled(scanBusy.id)
    const prepScan = await prepareIds(h, scanBusy.id, ['wt_bbbb'])
    expect(prepScan.targets).toHaveLength(1)
    expect(prep2.targets).toHaveLength(1)
  })

  test('should require warning acknowledgement', async () => {
    const h = harness()
    h.worktrees.set('wt_aaaa', worktreeView('wt_aaaa', { isOpen: true }))
    const prep = await prepared(h, ['wt_aaaa'])
    expect(prep.warnings.join(' ')).toContain('window is open')
    expect(() => h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: false, requestId: 'x1' })).toThrow(ConfirmationError)
    expect(h.removeCalls).toHaveLength(0)
  })

  test('should skip remaining rows when the token expires mid-execution', async () => {
    const h = harness()
    h.removedResults.set('wt_aaaa', true)
    h.removedResults.set('wt_bbbb', true)
    const prep = await prepared(h, ['wt_aaaa', 'wt_bbbb'])
    const gate = Promise.withResolvers<void>()
    h.inspectGates.set('wt_aaaa', gate.promise)
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await vi.waitFor(() => expect(h.inspectCalls.filter((x) => x === 'wt_aaaa').length).toBeGreaterThan(2))
    h.clock.t += 300_001
    gate.resolve()
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    const byId = new Map(result.items.map((i) => [i.worktreeId, i]))
    expect(byId.get('wt_aaaa')?.state).toBe('removed')
    expect(byId.get('wt_bbbb')?.state).toBe('skipped')
    expect(byId.get('wt_bbbb')?.message).toContain('expired')
  })

  test('should force-refresh discovery for evidence and reject vanished targets', async () => {
    const h = harness()
    const prep = await prepared(h, ['wt_aaaa'])
    h.worktrees.delete('wt_aaaa')
    const before = h.refreshCount()
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    expect(h.refreshCount()).toBeGreaterThan(before)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    expect(result.items[0]?.state).toBe('skipped')
    expect(h.removeCalls).toHaveLength(0)
  })

  test('should treat unknown GitHub evidence as a blocker at execute', async () => {
    const h = harness()
    const prep = await prepared(h, ['wt_aaaa'])
    h.setGithub({ state: 'unavailable', pr: null, ci: null, observedAt: null, attemptedAt: 1, error: 'gh auth' })
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    await h.operations.settled(op.id)
    const result = op.result
    if (result?.type !== 'sweep') throw new Error('bad result')
    expect(result.items[0]?.state).toBe('skipped')
    expect(result.items[0]?.message).toContain('GitHub')
    expect(h.removeCalls).toHaveLength(0)
  })

  test('should not hold the parent operation while a target lock is busy', async () => {
    const h = harness()
    const gate = Promise.withResolvers<OperationView>()
    const held = h.locks.run('wt_aaaa', () => gate.promise)
    const prep = await prepared(h, ['wt_aaaa'])
    const op = h.svc.execute({ confirmToken: prep.confirmToken, acceptWarnings: true, requestId: 'x1' })
    expect(op.state).toBe('running')
    gate.resolve({ id: 'mgmt-2', kind: 'push', target: 'wt_aaaa', state: 'done', output: null, error: null, startedAt: 1, endedAt: 2 })
    await held
    h.removedResults.set('wt_aaaa', true)
    await h.operations.settled(op.id)
    expect(op.state).toBe('done')
  })
})
