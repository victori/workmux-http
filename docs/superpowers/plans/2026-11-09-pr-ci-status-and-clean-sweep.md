# PR/CI Status and Clean Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface trustworthy PR/CI status and add a confirmed, scoped, non-force clean sweep with per-worktree outcomes.

**Architecture:** A typed GitHub adapter and shared stale-aware cache enrich existing discovery without putting network calls on its critical path. A separate sweep service consumes fresh evidence and shares Management's worktree locks; the existing operation registry carries scan and execution results. Deliver PR/CI first, then sweep.

**Tech Stack:** Node ≥22, TypeScript 5.9, Fastify 5, zod 4, React 19, Tailwind 4, Vitest 5, Playwright, local `gh`/`git`/`workmux`/`tmux`.

**Spec:** [feature design](../specs/2026-11-09-pr-ci-status-and-clean-sweep-design.md);
[current-state specification](../../SPEC.md).

**Status:** implemented (both phases, 2026-11-09); status reconciled 2026-11-10.
**Verification:** historical phase completion and gate results are recorded in
the [scaffold amendments](2026-11-07-workmux-http-dashboard.md), under the
2026-11-09 phase entries. The 2026-11-10 CI GraphQL fix is recorded there too.
Original task checkboxes below are retained as planning history, not a fresh
task-by-task verification report or authorization to operate on live worktrees.
Current documentation workflow follows [AGENTS.md](../../../AGENTS.md);
instructions below to append to the scaffold plan describe the old workflow.

## Global Constraints

- Node ≥22; npm; no new runtime dependency is required.
- Do not git commit or push anything, leave it up to the human to be in the loop.
- Before modifying any existing untracked file, create a timestamped `.bak` backup.
- `server/exec.ts` is the sole runtime subprocess gateway; argv only, no shell.
- `shared/types.ts` is the API source of truth; server imports use `.js` suffixes.
- Preserve managed-only targets and existing host/origin/header gates.
- Never send messages to real agents during tests or remove real worktrees.
- No automatic retries of ambiguous removal; no force path for sweep.
- Main/base worktrees, dirty worktrees, and live agent targets are not sweepable.
- Keep local branches by default; delete a branch only after explicit selection and ancestry proof.
- Use existing theme tokens, 44px tap targets, and `text-base md:text-sm` inputs.
- New server tests use `test('should…')`; client tests use third-person `it('…')`.
- Each implementation phase updates SPEC, README, and the canonical plan's Amendments.
- Do not update current-state documents to describe unimplemented features during planning.

## Evidence inspected

- `server/services/discovery.ts`: 2-second core cache and 60-second PR URL cache;
  GitHub capability failure is currently sticky, and URL lookup failure is null.
- `server/adapters/git.ts:321`: `gh pr view --head` is invalid according to
  the installed `gh pr view --help`. Replace it with structured supported calls.
- `server/services/management.ts:510`: single remove maps acknowledgement to
  force; sweep must not call this path with its own warning acknowledgement.
- `server/services/management.ts:562`: locks wait for `Operations.settled`;
  preserve this behavior when sharing the lock coordinator.
- `shared/types.ts:273`: operation states already include `unknown`, although
  the current operation runner only settles to done/failed.
- Upstream v0.1.281 `src/command/list.rs`: JSON mode excludes PR enrichment.
- Upstream `src/github.rs`: PR lifecycle plus CheckRun/StatusContext and
  branch-only checks; `src/command/dashboard/app/worktrees.rs`: four sweep
  reasons and dirty-row selection blocking. Do not copy its force helper.

## File ownership and delivery map

| Unit | Create | Modify |
| --- | --- | --- |
| GitHub adapter/normalization | `server/adapters/github.ts`, `server/adapters/github.test.ts` | `shared/types.ts`, `server/adapters/git.ts`, `server/adapters/git.test.ts`, `server/config.ts` |
| GitHub cache/discovery | `server/services/github-status.ts`, `server/services/github-status.test.ts`, `fixtures/github-status.json` | `server/services/discovery.ts`, `server/services/discovery.test.ts`, `server/index.ts` |
| PR/CI presentation | `src/components/PrCiStatus.tsx`, `src/components/PrCiStatus.test.tsx`, `e2e/pr-ci.spec.ts` | dashboard cards/tests, `src/features/dashboard/DashboardView.tsx`, `src/App.tsx` |
| Shared locks/results | `server/services/target-locks.ts`, `server/services/target-locks.test.ts`, `server/services/operations.test.ts` | `server/services/management.ts`, `server/services/operations.ts`, `server/index.ts`, `shared/types.ts` |
| Cleanup evidence/policy | `server/adapters/sweep-git.ts`, `server/adapters/sweep-git.test.ts`, `server/services/sweep-policy.ts`, `server/services/sweep-policy.test.ts` | `server/adapters/workmux.ts`, `server/adapters/workmux.test.ts` |
| Sweep coordinator/routes | `server/services/sweep.ts`, `server/services/sweep.test.ts`, `server/sweep.routes.test.ts` | `server/index.ts`, `shared/types.ts`, `server/config.ts`, `src/lib/api.ts` |
| Sweep presentation | `src/features/worktrees/SweepSheet.tsx`, `src/features/worktrees/SweepSheet.test.tsx`, `e2e/sweep.spec.ts` | `src/features/dashboard/DashboardView.tsx`, its test, `src/App.tsx` |
| Documentation/proofs | `integration/sweep.integration.test.ts` | `docs/SPEC.md`, `README.md`, `docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md` |

Constructor-wiring changes also affect `server/services/input.test.ts`,
`server/services/management.hunks.test.ts`, `server/services/management.commit.test.ts`,
and `server/services/management.push.test.ts`. Update their dependency factories;
do not make network access the default of a fake.

## Phase 1 — PR/CI visibility

### Task 1: Define and implement the GitHub boundary

**Files:** Shared types, Git/GitHub adapters and tests, config from the map.

**Interfaces:** `GithubRequest`, `GithubTarget`, and `GithubLike` live in the
GitHub adapter; the display types live in `shared/types.ts`.
`resolveGithubRequest(cwd, branch, headOid)` in the Git adapter uses only local
Git metadata and returns a request or a typed unsupported/ambiguous error.
The GitHub adapter resolves fork-parent metadata asynchronously inside `read`,
producing a GithubTarget before querying PRs. Neither accepts browser identities.

- [ ] Add these contracts first; mark `WorktreeView.github?: GithubStatus`
  additive during migration. `prUrl` stays available as a compatibility projection.
  Add `GitInfo.headOid?: string | null`; Discovery will populate it from the
  existing `git.repoStatus().oid` rather than guessing HEAD from a branch name.

```ts
export type CiState = 'none' | 'pending' | 'passing' | 'failing' | 'unknown'
export interface CiSummary {
  state: CiState
  commitOid: string
  complete: boolean
  counts: { passing: number; failing: number; pending: number; neutral: number; unknown: number }
  checks: Array<{ name: string; state: CiState; url: string | null }>
}
export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  review: 'approved' | 'changes_requested' | 'review_required' | 'unknown'
  headOid: string
  headRepository: string
  baseRepository: string
  baseBranch: string
}
export interface GithubStatus {
  state: 'loading' | 'ready' | 'stale' | 'unavailable' | 'unsupported'
  pr: PullRequestInfo | null
  ci: CiSummary | null
  observedAt: number | null
  attemptedAt: number | null
  error: string | null
}
export interface GithubRequest {
  worktreePath: string
  headRepository: string
  configuredBaseRepository: string | null
  branch: string
  headOid: string
}
export interface GithubTarget extends GithubRequest {
  baseRepository: string
}
export interface GithubLike {
  read(request: GithubRequest): Promise<GithubStatus>
}
```

- [ ] Add direct regression declarations in `server/adapters/github.test.ts`:
  `should use supported gh arguments for PR lookup`, `should distinguish no PR
  from provider failure`, `should scope checks to the exact local commit`,
  `should match the head repository as well as the branch`, and `should never
  report incomplete checks as passing`. Use `vi.mock('../exec.js')` with a
  queued `RunResult` response; assert complete argv and cwd, not just the label.

```ts
test('should use supported gh arguments for PR lookup', async () => {
  const { target, read, calls } = githubHarness()
  await read(target)
  expect(calls.some(({ argv }) => argv.includes('--head') && argv.includes('view'))).toBe(false)
  expect(calls.every(({ argv }) => argv[0] === 'gh')).toBe(true)
})
```

  Define `githubHarness()` in that test file: fixed owner/repo/branch/40-character
  HEAD request named `target`, configuredBaseRepository set to the same repo,
  mocked `run` call recorder, successful empty PR response, and a
  successful exact-HEAD CI response. Return `{ target, read: adapter.read.bind(adapter), calls }`.
  First reproduce the old helper's invalid argv, then replace it and prove the
  regression passes. Missing new modules alone are not proof of the old bug.
- [ ] Run `npx vitest run server/adapters/github.test.ts server/adapters/git.test.ts`;
  capture the failing invalid-argv assertion before replacing `git.prUrl`.
- [ ] Implement identity resolution as specified in design §3. Test GitHub
  secondary remote with Gitea origin, tracking remote, fork/upstream, branch-name
  collision across owners, multiple ambiguous remotes, hostile ref names, and
  unsupported hosts. No credential material goes into errors/cache keys.
- [ ] When configuredBaseRepository is null, resolve the fork parent with a
  bounded `gh api graphql` repository query inside `read`; otherwise use the
  configured base. The service's result TTL covers this read; do not add a
  second adapter cache that `fresh` cannot bypass. A failed parent query is
  unavailable, not permission to guess a base.
  Name the resulting local variable `target: GithubTarget` in the lookup code.
- [ ] Implement PR lookup with supported JSON CLI calls, not stderr matching.
  Use a complete bounded result set and match head identity in parsed JSON:

```ts
const argv = [
  'gh', 'pr', 'list', '--repo', target.baseRepository,
  '--head', target.branch, '--state', 'all', '--limit', '100',
  '--json', 'number,title,url,state,isDraft,reviewDecision,headRefOid,headRepository,baseRefName,updatedAt',
]
const result = await run(argv, { cwd: target.worktreePath, timeoutMs: BOUNDS.githubTimeoutMs })
```

  Put the limit in `BOUNDS.githubPrLimit`, not a runtime magic literal. At the
  limit, return unavailable/ambiguous until pagination is implemented; never
  declare “No PR” from an incomplete list. Validate schema, exit code, and
  `result.truncated` before selecting a PR. GraphQL per-field errors are errors,
  including when the CLI exits zero.
- [ ] Query exact-HEAD CI through `gh api graphql` using typed variables for
  owner/name/OID, no interpolated GraphQL. Query repository.object(oid), Commit
  statusCheckRollup.contexts and pageInfo; include CheckRun name/status/conclusion/
  detailsUrl and StatusContext context/state/targetUrl. Follow cursors up to
  five pages of 100, with a total job deadline, and mark incomplete on exhaustion.
  An unknown Commit or null rollup is unknown, not an empty successful set.
- [ ] Implement normalization with exhaustive known enum tables: failure,
  timed-out, cancelled, action-required, startup-failure, stale/error are
  failing; queued/in-progress/waiting/requested/pending are pending;
  success is passing; neutral/skipped are neutral; unrecognized is unknown.
  Zero contexts is none. All neutral is none. Unknown/incomplete prevents
  passing; known failure still shows failing with `complete: false` if needed.
- [ ] Set `githubTimeoutMs=10000`, `githubJobTimeoutMs=30000`,
  `githubPrLimit=100`, `githubPageSize=100`, `githubMaxPages=5`, and
  `githubMaxVisibleChecks=20` in BOUNDS. Truncating the displayed list must not
  truncate aggregation. Permit only HTTPS `github.com` returned links initially.
- [ ] Run adapter tests and `npm run typecheck`; review no-PR, permission,
  rate-limit, malformed, partial, and unpublished-commit behavior independently.

### Task 2: Share bounded GitHub refresh without delaying discovery

**Files:** GitHub status service/tests, discovery/tests, index, fixture file.
**Consumes:** `GithubLike.read`, `GithubRequest`, `GithubStatus` from Task 1.
**Produces:**

```ts
class GithubStatusService {
  constructor(provider: GithubLike, now?: () => number)
  view(request: GithubRequest): GithubStatus
  fresh(request: GithubRequest): Promise<GithubStatus>
  retain(requests: GithubRequest[]): void
}
```

- [ ] Write fake-clock/deferred-provider tests before implementation. `view`
  returns immediately; `fresh` bypasses completed cache and returns only a
  fresh provider result, not a stale fallback. In-flight work may be shared
  only for the identical target key and a read started after the fresh request;
  otherwise schedule one subsequent deduplicated read.

```ts
test('should not block discovery on a pending GitHub request', async () => {
  const pending = Promise.withResolvers<GithubStatus>()
  const service = new GithubStatusService({ read: () => pending.promise })
  expect(service.view(target).state).toBe('loading')
  pending.resolve(readyStatus)
  await service.fresh(target)
  expect(service.view(target).state).toBe('ready')
})
```

  Define `target` and `readyStatus` literals in the test; supply all fields from
  Task 1. Add `should preserve last good PR data with a stale marker`, `should
  retry missing gh after backoff`, and `should isolate an older HEAD refresh`.
- [ ] Run `npx vitest run server/services/github-status.test.ts server/services/discovery.test.ts`
  and record expected failures.
- [ ] Implement per-key successful TTL 60000ms, failure backoff 15000ms,
  concurrency 4, pending queue 100, cache limit 1000. Coalesce identical queued
  work; queue exhaustion yields unavailable, never an unbounded backlog.
  Use BOUNDS constants. Prune departed keys and prevent their late completions
  from reintroducing data. No recurring timer is needed: `view` schedules work.
- [ ] Inject one service from `buildApp` into Discovery and later Sweep.
  Remove Discovery's `prCache`, permanently cached `ghAvailable`, and legacy
  `git.prUrl` call. Resolve local identity from cached Git data; do not await
  GitHub repository/fork metadata on the discovery critical path: `view` accepts
  the local GithubRequest and the adapter resolves the base asynchronously.
  Include configuredBaseRepository in cache keys. While resolving the base,
  emit loading; a failed resolution emits unavailable rather than guessed data.
  Populate GitInfo.headOid in gitInfoFor from the parsed status OID. A missing
  OID yields unavailable/unborn without a provider call. When discovery observes
  a changed HEAD, immediately stop displaying the prior key's CI status. Existing
  Git polling still determines when a local HEAD change is first observed;
  do not promise instantaneous filesystem freshness.
- [ ] Join the same worktree status to agents by `worktreeId`; do not fetch
  once per agent. Retain existing `sources` keys and connection derivation.
  Update all Discovery constructor call sites listed above with explicit fakes.
- [ ] Add a versioned `fixtures/github-status.json` keyed by fixture worktree
  identity, with ready/stale/unavailable/none examples. Fixture mode loads it
  instead of invoking gh or resolving real remotes. Missing fixture data yields
  unavailable, not a production fallback.
- [ ] Re-run service/discovery tests, existing `src/hooks/useDashboard.test.ts`,
  and `npm run typecheck`; assert optional GitHub failure does not turn core
  connectivity offline (INV-06, INV-10).

### Task 3: Present PR/CI and finish the independently shippable first phase

**Files:** PR/CI component/tests, dashboard cards/tests, DashboardView, App,
`e2e/pr-ci.spec.ts`, SPEC, README, canonical Amendments.
**Consumes:** `GithubStatus`, worktree/agent association.
**Produces:** Named component and exported props interface:

```tsx
export interface PrCiStatusProps { status: GithubStatus | undefined }
export function PrCiStatus({ status }: PrCiStatusProps) {
  if (!status || status.state === 'loading') return <span>PR/CI loading…</span>
  if (status.state === 'unsupported') return <span>PR/CI unsupported</span>
  if (status.state === 'unavailable') return <span>PR/CI unavailable</span>
  return (
    <div>
      {status.pr ? <a href={status.pr.url} target="_blank" rel="noopener noreferrer">PR #{status.pr.number} · {status.pr.state}</a> : <span>No PR</span>}
      <span>CI: {status.ci?.state ?? 'unknown'}</span>
      {status.state === 'stale' && <span role="status">PR/CI data outdated</span>}
    </div>
  )
}
```

  This is the minimal red-to-green rendering skeleton; complete it with token
  styles, review text, checked-commit identity, accessible details controls,
  count labels, fetched age, error reason, and returned check links from §3.
  Stale null PR uses “Last checked: no PR”, not an unqualified current absence.
- [ ] Write `renders PR lifecycle and review status`, `does not show unknown
  checks as passing`, `labels stale no-PR results as historical`, and
  `renders branch CI without a PR` tests using complete typed literal fixtures.
  Include keyboard/link behavior; links must not be nested inside the card's
  existing button and clicking them must not navigate to the agent.
- [ ] Run `npx vitest run src/components/PrCiStatus.test.tsx src/features/dashboard/AgentCard.test.tsx`.
- [ ] Mount the component outside each card's main navigation button. Pass
  worktree status down from DashboardView, looking up agents by worktree ID.
  Preserve existing branch, pending-file, and unpushed badges.
- [ ] Add details-sheet tests for pending/failing check names, safe external
  links, stale age, and missing information. Add deterministic fixture-backed
  Playwright cases for open/draft/merged/closed PRs, failing/pending checks,
  unsupported provider, provider failure, and no-PR branch checks.
- [ ] Update SPEC data/freshness contracts and INV-06/INV-10 test mappings,
  README gh authentication/unsupported-host behavior, and canonical Amendments.
  Correct the misleading parity rows only where this phase supplies evidence;
  do not claim Sweep exists yet.
- [ ] Run the phase gate: `npm run typecheck && npm test && npm run build && npm run test:e2e`.
  Perform read-only `/api/health` and `/api/dashboard` smoke against the intended
  local instance. GitHub live reads are optional; disclose if only fixtures
  establish provider semantics. Review this phase before starting deletion work.

## Phase 2 — Safe bulk clean sweep

### Task 4: Define sweep contracts and pure eligibility policy

**Files:** Shared types, sweep-policy service/tests, config.
**Consumes:** Fresh PR status, Git safety facts, current managed/core/tmux evidence.
**Produces:** `SweepFacts`, `classifySweep(facts, keepBranches): SweepCandidate`,
and the following public types (shared/types.ts first):

```ts
export type SweepReason = 'pr_merged' | 'pr_closed' | 'upstream_gone' | 'merged_locally'
export interface SweepCandidate {
  worktreeId: string
  targetLabel: string
  branch: string
  path: string
  reason: SweepReason | null
  blockers: string[]
  warnings: string[]
}
export interface SweepScan {
  type: 'sweep_scan'
  candidates: SweepCandidate[]
  expiresAt: number
}
export interface SweepItem {
  worktreeId: string
  targetLabel: string
  state: 'pending' | 'running' | 'removed' | 'skipped' | 'failed' | 'unknown'
  message: string | null
}
export interface SweepResult { type: 'sweep'; items: SweepItem[] }
export type OperationResult = SweepScan | SweepResult
export interface SweepScanRequest { worktreeIds: string[]; requestId: string }
export interface SweepPrepareRequest {
  scanId: string
  worktreeIds: string[]
  keepBranches: boolean
  requestId: string
}
export interface PreparedSweep {
  confirmToken: string
  expiresAt: number
  targets: SweepCandidate[]
  keepBranches: boolean
  warnings: string[]
}
export interface SweepExecuteRequest {
  confirmToken: string
  acceptWarnings: boolean
  requestId: string
}
```

- [ ] Define internal `SweepFacts` in sweep-policy.ts: canonical identity/label,
  branch/path/headOid/baseOid, isMain/isBase/detached/unborn flags, dirty/conflict/
  operation-in-progress booleans, liveAgentPaneIds, isOpen, health state,
  `upstream: 'none' | 'present' | 'gone' | 'unknown'`,
  `mergedIntoBase: boolean | null`, and `github: GithubStatus`.
  Keep evidence hashes internal to the service, never client-editable fields.
- [ ] Add direct named regressions for every blocker in design §4. Use table
  tests for combinations, but literal standalone test titles for SPEC mappings.

```ts
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
```

  Define `cleanFacts(): SweepFacts` locally with a non-main, clean, closed
  worktree; no live panes; a fresh merged PR at its exact HEAD; known base;
  healthy sources; and all required fields explicitly populated.
- [ ] Run `npx vitest run server/services/sweep-policy.test.ts` and capture red.
- [ ] Implement a pure classifier, preserving reason precedence. Use independent
  blocker accumulation before eligibility; a candidate reason never overrides
  dirty/unknown/live-agent/open-PR protections. Require exact PR HEAD for PR
  reasons. An unsupported provider permits only local evidence; unavailable
  GitHub does not. No mutation, network access, or current-clock calls here.
- [ ] Set BOUNDS scan size 100, execution size 20, active scans 1, active sweeps 1,
  scan TTL 300000ms, selection token TTL equal to `confirmTokenTtlMs`,
  maximum stored scans 20, maximum stored tokens 100, and sweep dedup retention
  equal to `dedupTtlMs` with `dedupMaxEntries` capacity.
- [ ] Re-run policy tests and typecheck. Review closed-PR, upstream-gone,
  squash-merge, unsupported-provider, and detached-HEAD cases separately.

### Task 5: Share locks and support structured operation results

**Files:** Target-locks service/tests, Operations/tests, Management, index,
shared types, and existing Management test constructors.
**Consumes:** Existing `Operations.settled` lifetime guarantee and Task 4's
`OperationResult` union.
**Produces:** `TargetLocks.run<T>(targetId, job): Promise<T>` shared by both
services; optional typed `OperationView.result` and outcome terminal state.

- [ ] Write `should hold a worktree lock until its returned operation settles`
  and `should serialize a sweep callback behind a management operation` with
  deferred promises; assert entry order before releasing the gate.
- [ ] Run `npx vitest run server/services/target-locks.test.ts server/services/management.hunks.test.ts`.
- [ ] Extract Management's existing lock behavior into one injected coordinator,
  retaining the distinction between job return and operation settlement:

```ts
export class TargetLocks {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly operations: Operations) {}
  run<T>(targetId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(targetId) ?? Promise.resolve()
    const next = previous.then(job, job)
    const held = next.then(async (value) => {
      const operationId = (value as { id?: unknown } | null)?.id
      if (typeof operationId === 'string') await this.operations.settled(operationId)
    }).catch(() => undefined)
    this.tails.set(targetId, held)
    void held.finally(() => {
      if (this.tails.get(targetId) === held) this.tails.delete(targetId)
    })
    return next
  }
}
```

  Import Operations as a type. Management delegates all its existing locked
  mutations to this object. Sweep callbacks await removal directly and return
  a row, never a parent operation ID (which would deadlock on itself).
- [ ] Extend Operations' callback to receive `report(result: OperationResult)`
  and return `{ output, error?, result?, state?: 'done' | 'failed' | 'unknown' }`.
  Existing zero-argument callbacks remain valid. Copy progress arrays on report;
  don't expose mutable service state. Keep settled/retention semantics unchanged.
- [ ] Add `should preserve unknown outcomes without converting them to failed`
  and `should publish per-item progress before settlement`. Re-run all existing
  Management/input tests and `npm run typecheck`; update INV-03 coverage.

### Task 6: Collect safe Git evidence and expose non-force removal

**Files:** Sweep-Git adapter/tests, Workmux adapter/tests, disposable integration test.
**Consumes:** Managed WorktreeView and validated refs.
**Produces:**

```ts
export interface SweepGitLike {
  inspect(worktree: WorktreeView): Promise<SweepGitFacts>
  removed(worktree: WorktreeView, keepBranches: boolean): Promise<boolean>
}
```

  Define `SweepGitFacts` in sweep-git.ts as the Git-only fields of SweepFacts:
  canonical path/repository identity, branch/path/headOid/baseOid, isBase,
  detached, unborn, dirty, conflicts, operationInProgress, upstream identity
  and state, and mergedIntoBase. Git failures reject; they never return clean.
- [ ] Write real-temp-repository tests for clean/dirty/staged/untracked/conflict,
  in-progress operations, safe base ancestry, unmerged and squash-merged HEAD,
  no upstream, missing local tracking ref, remote missing branch, and remote
  read failure. Use a local bare remote in tests; no real origin is contacted.
- [ ] Run `npx vitest run server/adapters/sweep-git.test.ts server/adapters/workmux.test.ts`.
- [ ] Implement reads through exec.run: porcelain v2 `-z` with all untracked
  files, resolved HEAD/base SHAs, worktree metadata and canonical path, operation
  sentinel paths resolved by Git, upstream remote/ref config, and
  `merge-base --is-ancestor`. Treat exit 1 as not ancestor and other errors as
  unknown. Validate repo-controlled refs using SAFE_REV before revision commands.
  `ls-remote` only queries the configured upstream remote/ref, with option-safe
  argv; reject unsafe helper protocols. A deleted local tracking ref alone is
  not enough. Do not compare ahead/behind counts as an ancestry substitute.
- [ ] Extend Workmux.remove options additively, leaving existing callers unchanged:

```ts
async remove(opts: { cwd: string; name: string; force?: boolean; keepBranch?: boolean }): Promise<RunResult> {
  const argv = [this.bin, 'remove', opts.name]
  if (opts.force) argv.push('-f')
  if (opts.keepBranch) argv.push('--keep-branch')
  return this.exec(argv, { cwd: opts.cwd })
}
```

- [ ] Add `should preserve the branch without force for a sweep removal`
  using fakeWorkmux's argv log. Test missing `--keep-branch` support as a
  surfaced dependency failure, not a fallback to force. Keep the installed
  v0.1.281 behavior as the compatibility baseline.
- [ ] Implement postcondition reads without relying on discovery's last-good
  list: exact worktree absent, and the local branch retained/deleted as promised.
  If evidence cannot confirm the result, return an unknown outcome upstream.
- [ ] In `integration/sweep.integration.test.ts`, use only disposable repos and
  a dedicated tmux socket to prove clean removal, branch retention, and native
  dirty refusal. Skip with an explicit reason if native dependencies are absent;
  fake argv assertions are not a native deletion proof.
- [ ] Re-run adapter/policy tests and typecheck; review INV-01, INV-07, INV-08.

### Task 7: Implement scan, preparation, and sequential execution

**Files:** Sweep service/tests, routes/tests, index, api.ts, Operations wiring.
**Consumes:** Shared locks, operation results, classifier, GitHub service,
SweepGitLike, and Workmux.remove from Tasks 1–6.
**Produces:**

```ts
class SweepService {
  scan(request: SweepScanRequest): OperationView
  prepare(request: SweepPrepareRequest): Promise<PreparedSweep>
  execute(request: SweepExecuteRequest): OperationView
}
```

  Constructor dependencies: Discovery, GithubStatusService, SweepGitLike,
  `Pick<Workmux, 'remove'>`, TargetLocks, Operations, and an injectable clock.
  Store token/scan/dedup state privately; no production method widened for tests.
- [ ] Write black-box tests with deferred fake removal. Minimum standalone names:
  `should reject unmanaged sweep targets`, `should consume sweep tokens before
  concurrent execution`, `should skip a target changed while waiting for its
  management lock`, `should preserve branches without forcing removal`,
  `should continue safe rows after a known failure`, and `should never retry
  an ambiguous removal`. Assert calls and untouched targets as well as statuses.
- [ ] Add a typed service harness in sweep.test.ts with mutable managed snapshots,
  deferred remove promise, injected clock, and fresh/failed PR reads. Include
  time passing while queued, replaced path with reused ID, HEAD/base/upstream
  changes, fresh unknown GitHub, failed workmux/tmux discovery, token replay,
  duplicate ID/payload mismatch, invalid selection, and failed postconditions.
- [ ] Run `npx vitest run server/services/sweep.test.ts server/services/target-locks.test.ts`.
- [ ] Implement async scan via Operations.start; save its exact-scope evidence
  only on completion. Every row records blockers; do not omit failed inspections.
  Preparation requires a completed nonexpired scan and exact subset, refreshes
  all evidence, and rejects changed keys before returning any usable token.
  Include branch-preservation choice, ignored-file warning, and open-window
  closure warning. Empty or duplicate selections fail schema validation.
- [ ] Implement synchronous request-ID lookup/token consumption and operation
  creation before awaiting removals. For each target, use the following sequence;
  each named operation is a private helper in sweep.ts, not a second API:

```text
execute: dedup lookup -> capacity/ack/expiry validation -> consume token
         -> register operation -> remember requestId+payload+operation
for each stored target:
  shared TargetLocks.run(worktreeId):
    verify token expiry again
    collectFreshFacts(target) -> classifySweep -> evidenceKey comparison
    mismatch/blocker: report skipped and return
    report running
    Workmux.remove({ cwd, name, force: false, keepBranch: keepBranches })
    inspect exit/truncation/timeout -> verify removed() postcondition
    report removed / failed / unknown
settle: unknown if any unknown; failed if any nonremoved; otherwise done
```

  `collectFreshFacts` force-refreshes Discovery, rejects stale workmux/tmux
  membership, calls SweepGitLike.inspect and the same-key GithubStatusService.fresh,
  and combines facts. Re-read cheap local HEAD/status/panes after the network
  read to narrow the race. `evidenceKey` uses a deterministic ordered structure
  and the existing hashing utilities, excluding time and CI progress. Freeze
  exact target identities in the token, not just display labels.
- [ ] Handle timeouts (including run's code 124), truncated output, and partial
  removal as unknown unless a complete postcondition establishes the selected
  effects. Never silently retry. Clearly non-mutating refusal can be failed.
  Keep remaining safe rows independent; no rollback or force escalation.
- [ ] Add top-level zod schemas/routes in index.ts, operation response typing,
  and API client `scanSweep`, `prepareSweep`, `executeSweep`, each taking the
  exact shared request and sending the mutation header. Bound IDs and requestId
  with existing validation patterns, reject unknown fields, and never accept
  paths, shell arguments, `force`, or client evidence.
- [ ] Add Fastify inject tests for 202 acceptance, 400 validation, 403 host/
  origin/header gates, 404 unmanaged target, 409 snapshot_stale/
  confirmation_required/sweep_busy, and existing operation polling. For async
  scan failures assert the terminal operation error, not an invented HTTP 502.
- [ ] Re-run focused service/routes/security tests and typecheck; document API
  tables/state machines and named INV-01/02/03/06/08 mappings in SPEC in this task.

### Task 8: Build the mobile sweep review and result flow

**Files:** SweepSheet/tests, DashboardView/tests, App, api.ts, `e2e/sweep.spec.ts`.
**Consumes:** Typed sweep APIs and existing api.operation/loadTab/saveTab.
**Produces:**

```ts
export interface SweepSheetProps {
  worktreeIds: string[]
  onClose: () => void
  onChanged: () => void
}
type SweepUiState =
  | { phase: 'idle' }
  | { phase: 'scanning'; operationId: string }
  | { phase: 'selecting'; scanId: string; scan: SweepScan }
  | { phase: 'reviewing'; prepared: PreparedSweep }
  | { phase: 'running'; operationId: string }
  | { phase: 'finished'; operation: OperationView }
```

- [ ] Write tests before UI: `starts with no cleanup targets selected`,
  `selects only eligible rows in the scanned scope`, `keeps branches by default`,
  `invalidates confirmation when the selection changes`, `does not treat 202
  as removal success`, and `resumes polling a retained sweep operation`.
  Mock api with its full surface and ApiError, following existing test patterns.
- [ ] Run `npx vitest run src/features/worktrees/SweepSheet.test.tsx src/features/dashboard/DashboardView.test.tsx`.
- [ ] Add Clean sweep only to the Worktrees tab. Capture displayed IDs on open;
  subsequent dashboard filters/polls do not silently alter the scan scope.
  Require an explicit rescan to change it. Show errors with role=status and
  disable scans that exceed the stated cap.
- [ ] Implement selection, blockers, optional branch-deletion mode, prepare,
  exact-target confirmation with warnings acknowledgement, and per-item
  progress/results. Changing keepBranches back to false must re-evaluate branch
  ancestry in prepare, not merely toggle a client checkbox.
- [ ] Keep the sweep operation ID in sessionStorage key `sweepOperationId`
  through loadTab/saveTab. Poll at 1000ms only when visible; cancellation flags
  stop state updates, not server execution. Resume after sheet reopen/tab reload.
  A missing operation is explicitly unknown and requires rescan, not resend.
  Do not add a Cancel action that pretends to roll back running removals.
- [ ] Refresh dashboard after terminal execution results. Clear stored IDs
  only after result acknowledgement. Preserve partial/unknown information;
  never collapse a mixed result into a success toast.
- [ ] Add Playwright request interception for the new mutation routes and
  operation polling. Verify scan -> select -> review -> confirm -> mixed
  results and stale rejection on iPhone viewport; no real removal endpoint
  should be reached. Test native keyboard selection and 44px controls.
- [ ] Re-run component tests and `npx playwright test e2e/pr-ci.spec.ts e2e/sweep.spec.ts`.

### Task 9: Documentation, safety review, and final verification

**Files:** SPEC, README, canonical Amendments; affected regression tests.
**Consumes:** Passing phase/task evidence, not assumed test counts.
**Produces:** Updated current-state documentation and an honest verification report.

- [ ] Update README with PR/CI labels, gh auth/remote selection, unsupported
  hosts, no-check vs unknown, sweep scope/defaults, ignored-file warning,
  branch preservation, partial results, disconnect/restart limits, and deliberate
  differences from upstream. Do not describe `a` as stage-all or `o` as file-open.
- [ ] Append a dated canonical amendment recording both phases, why native
  non-force removal differs from upstream, and actual test/live evidence. Never
  rewrite original criteria. Add no AGENTS convention changes unless necessary.
- [ ] Update SPEC route/error/data/state-machine tables and invariant mappings
  with literal tests that exist. Keep stable INV IDs; preserve existing coverage
  limits and explicitly retain the external-writer race limitation.
- [ ] Run the mapped baseline tests plus new suites:

```sh
npx vitest run server/services/management.hunks.test.ts server/services/management.push.test.ts server/services/discovery.test.ts server/adapters/git.test.ts server/security.routes.test.ts src/hooks/useDashboard.test.ts src/features/agent/OutputPane.test.tsx server/docs.spec.test.ts
npx vitest run server/adapters/github.test.ts server/services/github-status.test.ts server/services/target-locks.test.ts server/services/operations.test.ts server/adapters/sweep-git.test.ts server/services/sweep-policy.test.ts server/services/sweep.test.ts server/sweep.routes.test.ts integration/sweep.integration.test.ts src/components/PrCiStatus.test.tsx src/features/worktrees/SweepSheet.test.tsx
npm run typecheck && npm test && npm run build && npm run test:e2e
```

- [ ] Run read-only local `/api/health` and `/api/dashboard` smoke after server
  changes. Do not exercise sweep against live projects or send agent messages.
  Report skipped native dependencies and fixture-only GitHub evidence separately.
- [ ] Review the full diff against design §§1–6: no provider errors mistaken for
  empty results; no stale-green badge; no branch-only PR collision; no removal
  outside selected IDs; no warning-to-force mapping; no separate sweep lock;
  no silent retry; no undocumented branch/ignored-file/window effects.
- [ ] Fix actionable review findings and rerun affected checks. Leave changes
  uncommitted and unpushed for human review.

## Coverage and execution order

| Design requirement | Implementation tasks | Primary evidence |
| --- | --- | --- |
| PR/CI identity, aggregation, safe absence | 1 | GitHub/Git adapter tests |
| Freshness without slowing discovery; INV-06/10 | 2–3 | Cache, discovery, connection, UI tests |
| Exact selection/confirmation; INV-01/02 | 4, 7–8 | Policy, service, route, sheet tests |
| Shared lock and stale revalidation; INV-03 | 5, 7 | Deferred cross-service concurrency tests |
| No-force, branch preservation, safe refs; INV-07/08 | 4, 6–7 | Real-Git + argv + native disposable checks |
| Partial/unknown/disconnect semantics | 5, 7–8 | Operations, sweep, UI, Playwright tests |
| Current-state docs and regression safety | 3, 7, 9 | docs.spec tests, full gate, read-only smoke |

Implement Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Contracts precede their
consumers, and phase 1 can ship before phase 2. Do not parallelize shared/types.ts,
server/index.ts, or Management lock changes. If using subagents, assign disjoint
adapter/UI test work only after the contracts are reviewed; keep integration
and deletion-policy review on the main execution path.
