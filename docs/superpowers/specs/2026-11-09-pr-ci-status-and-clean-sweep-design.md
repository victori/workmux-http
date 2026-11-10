# PR/CI Status and Clean Sweep — Proposed Design

**Date:** 2026-11-09
**Status:** Proposed for review; not an implemented contract or approval to delete anything.
**Baseline:** `docs/SPEC.md`; workmux 0.1.281, tag `v0.1.281`.
**Implementation plan:** `../plans/2026-11-09-pr-ci-status-and-clean-sweep.md`.

## 1. Specification delta

- **Before:** Worktrees expose an optional PR URL, but no PR lifecycle, review,
  or CI status. Removal is single-target. The current URL lookup invokes
  `gh pr view --head`, which the installed CLI does not support, and folds
  errors into `null`. Existing removal maps warning acknowledgement to force.
- **After:** Agents and worktrees expose explicit GitHub PR/CI state and
  freshness. A scoped, on-demand sweep scans cleanup candidates, allows an
  explicit subset selection, prepares an exact-target confirmation, and
  removes clean eligible worktrees asynchronously with per-item outcomes.
  Provider failure is never interpreted as no PR, passing CI, or a safe
  cleanup candidate. Sweep never invokes force removal.
- **Reason:** Close the PR/CI visibility and clean-sweep gaps with the TUI,
  while preserving the web app's managed-target and confirmation guarantees.
- **Invariants:** Extend coverage for INV-01, INV-02, INV-03, INV-06, INV-08,
  and INV-10. Preserve INV-04, INV-05, INV-07, INV-09, and INV-11 unchanged.
- **Verification:** Adapter payload/argv tests, cache/freshness tests, real
  disposable-Git safety tests, gated lock/token tests, component tests,
  fixture-only Playwright flows, the full gate, and read-only live smoke.

This is an architectural change delivered in two independently verifiable
phases: PR/CI visibility first, sweep second. Sweep consumes the first phase's
provider identity and fresh PR evidence; it must not implement another PR lookup.
Only planning documents change now. Update current-state SPEC, README, and the
canonical plan's Amendments when each implementation phase actually lands.

## 2. Alternatives and recommendation

1. **Consume workmux JSON directly:** smallest integration, but v0.1.281
   deliberately disables PR fetching for JSON output (`show_pr && !json`).
   Its JSON worktree records do not supply the needed PR/CI fields.
2. **Use the existing local `gh` authentication, behind a typed adapter
   (recommended):** explicit structured results, testable absence/failure
   distinction, and no new server credential store or runtime dependency.
3. **Call GitHub directly with a new token configuration:** avoids a CLI,
   but adds authentication/configuration scope unrelated to this gap.

Do not parse workmux's human-readable tables or read its internal cache files.
Do not add Postman workspace setup, an SDK, webhooks, scheduled cleanup, CI
reruns, PR mutations, a terminal preview redesign, or non-GitHub providers.

## 3. PR/CI scope and identity

### Provider selection

Use server-discovered Git remotes, never a client-provided URL, repository,
branch, command, or path. First release supports `github.com`; other hosts
are explicitly unsupported, not PR-free. Enterprise/provider configuration
is a separate extension.

Resolve the head repository by: a GitHub tracking remote for this branch;
otherwise GitHub `origin`; otherwise the sole GitHub remote. Multiple remaining
GitHub remotes are ambiguous and unavailable. This supports this checkout's
non-GitHub `origin` plus a single `github` remote. Parse HTTPS and standard
SSH/scp GitHub URLs; reject option-like names and arbitrary helper protocols.

Resolve the PR base repository from a configured GitHub `upstream` remote,
otherwise the head repository's GitHub fork parent, otherwise the head
repository itself. Record both repository identities. Match PRs by exact
head repository and branch, not branch name alone. Forks targeting a repository
other than this resolved base are outside the first release and must be
disclosed, rather than guessing a cross-repository association.

### Display contract

- PR: number, title, returned URL, OPEN/DRAFT/MERGED/CLOSED, review decision,
  head SHA, base branch, and head/base repository identity.
- CI for the **current local HEAD SHA**, including branches without a PR:
  pending, passing, failing, none, or unknown; check counts and a bounded
  list of failing/pending checks with safe returned links.
- A local commit not visible on GitHub is **unknown/unpublished**, not passing
  and not a successful empty check set. Never show the previous HEAD's green
  badge as evidence for the new HEAD.
- Expose loading, ready, stale, unavailable, and unsupported independently
  from PR existence. `ready` with `pr: null` means a successful complete query
  found no matching PR. Null/error/truncated GraphQL data is not absence.
- All-green means all observed checks passed; it does **not** mean branch
  protection requirements are satisfied or the PR is mergeable.
- Successful empty check contexts means “No checks.” Null rollup or unknown
  enum values means “Checks unknown.” Neutral/skipped checks are counted
  separately and cannot, by themselves, turn a badge green.
- Failures take precedence over pending; pending over passing; unknown or
  incomplete data must prevent a passing result. Known failures may still
  be displayed alongside an incomplete-data warning.

CI includes both CheckRun and legacy StatusContext records. PR selection
prefers a unique open PR for the exact head identity. Otherwise use the most
recent closed/merged matching PR, label its head SHA, and never treat a
historical PR as evidence for a different local commit. Multiple open matches
or a capped PR list produce an ambiguous result, not an arbitrary selection.

### Refresh and errors

Add a shared GitHub status service with 60-second successful-result TTL,
15-second failure retry delay, four concurrent provider jobs, bounded queues,
and in-flight deduplication. Cache keys include repository identities, branch,
and local HEAD. Old-key results cannot overwrite a newer branch/HEAD view.
An expired successful value is immediately marked stale while refreshing.
Background failures retain last-good data only for the same identity.

Dashboard discovery schedules provider reads and returns without awaiting the
network. Sweep explicitly awaits a fresh uncached read; display cache data is
never deletion evidence. Retry missing CLI/auth capability after the failure
delay, not only at process restart. Discard entries for vanished targets.

Keep `sources` and `deriveConnection` about the existing core sources. Optional
GitHub failure is disclosed on the PR/CI component, without claiming the tmux
connection is offline. This is an explicit INV-06/INV-10 extension.

Use only `server/exec.ts` for subprocesses. Validate JSON with zod, bound output,
timeouts, pagination, and public error text. Never return authentication tokens,
raw credential-bearing remotes, or an arbitrary URL scheme to the browser.

## 4. Clean-sweep policy

### Scope and candidate reasons

The Worktrees tab offers **Clean sweep** for the currently displayed worktree
IDs. The sheet states the exact scan scope; search/session filters cannot
silently broaden it. At most 100 IDs per scan and 20 per execution; larger
scopes require narrowing, not silent truncation. Start with nothing selected.

Match the upstream reasons, in precedence order:

1. PR merged, with exact head identity and local HEAD equal to its recorded head.
2. PR closed, with the same identity/HEAD requirement.
3. Configured upstream branch is verified absent by a successful remote query.
4. No configured upstream and local HEAD is an ancestor of the resolved base.

No upstream configuration is not “upstream gone.” A missing local tracking
ref is not remote absence. Check the configured upstream ref with bounded
`git ls-remote --exit-code --heads`; only its documented no-match result
establishes absence. Never fetch, prune, reset, merge, or rewrite refs as a
side effect of scanning. Do not infer merged state from `ahead` counts.

### Hard blockers

- Main worktree, resolved base branch, detached/unborn HEAD, unsafe refs,
  changed worktree identity, or unmanaged target.
- Tracked modifications, staged changes, untracked files, conflicts, or
  in-progress merge/rebase/cherry-pick/revert/bisect.
- Any live agent pane associated with the worktree, including done/stale
  statuses: idle or stale is not proof that a process is stopped. The user
  must close it through the existing explicit flow before sweeping.
- Unknown Git/tmux/workmux state or an unavailable required safety check.
- An open PR; it is protected even when a different cleanup hint exists.
- GitHub-backed targets whose current PR association cannot be verified.
  Non-GitHub targets may use local-only evidence, labeled “PR check unsupported.”
- PR-derived candidates whose HEAD changed after the PR closed/merged.

An open worktree window without a tracked agent is allowed with an explicit
warning that its remaining panes/processes will be closed. Recheck actual tmux
association, not just cached `agentStatuses`.

“Clean” excludes Git-ignored files, following normal Git status semantics.
Confirmation explicitly says the directory and any ignored files are removed.
Never override a native refusal to remove a directory; report it instead.

### Branch preservation

Default **Keep local branches** on. Closed PRs and gone upstreams are cleanup
hints, not evidence that local commits are disposable. Branch preservation
permits safe directory cleanup without losing their commit reference.

Turning this off is explicit and applies to the whole selection. Every selected
HEAD must then be proven an ancestor of its resolved local base immediately
before execution. Squash-merged PRs do not satisfy ancestry automatically;
keep their branches or clean them manually. Show branch-deletion consequences
in the exact-target confirmation.

Invoke `workmux remove` one target at a time with `force: false`, plus
`--keep-branch` when selected. Never reuse `acceptWarnings => force` from the
existing single-target route. Do not change that route's semantics in this work.
No bulk shell command, `--all`, `--gone`, `git clean`, or forced branch deletion.

These are intentional safety differences from upstream's preselected clean
rows and more aggressive removal helper, not claims of exact semantic parity.

## 5. API and execution state machine

Reuse the existing host/origin/header gates and `newRequestId()` conventions.
New routes are proposed, not currently registered:

| Route | Request | Result |
| --- | --- | --- |
| `POST /api/sweeps/scan` | managed `worktreeIds`, `requestId` | 202 `OperationView`; final typed scan result via operation polling |
| `POST /api/sweeps/prepare` | completed `scanId`, selected `worktreeIds`, `keepBranches`, `requestId` | exact labels, reasons, warnings, expiry, single-use token |
| `POST /api/sweeps/execute` | `confirmToken`, `acceptWarnings`, `requestId` | 202 `OperationView`; typed per-item progress/results |
| `GET /api/operations/:id` | existing route | existing fields plus optional discriminated `result` |

`scanId` is the completed scan operation ID. Retain server-side evidence until
scan expiry (five minutes); no client-supplied paths or evidence keys. Preparing
re-reads each selected row and rejects a changed/expired scan with 409
`snapshot_stale`, including nonselectable selections. Main/unmanaged target
validation uses the existing 404 `target_not_found` convention.

Tokens bind the sorted exact selection, canonical repository/worktree identity,
HEAD/base SHAs, branch/upstream identity, relevant PR/remote evidence, branch
preservation choice, warning text, and five-minute expiry. Exclude timestamps
and CI progress from evidence hashes: a check finishing must not invalidate
an otherwise unchanged cleanup decision. Evidence is re-read, not trusted.

Execute consumes the token synchronously before its first await. Deduplicate
request IDs before consumption: identical retries return the same operation;
reusing an ID for a different payload returns 400 `invalid_request`. Expired,
unknown, or replayed tokens with a new request ID return 409
`confirmation_required`. Unacknowledged warnings also require confirmation.
Capacity exhaustion returns 409 `sweep_busy`; allow one scan and one execution
at a time, and reject capacity before consuming a usable token.

Execute serially, acquiring the **same per-worktree lock as Management** for
each target. Inside the lock, verify token expiry, force-refresh managed/core
discovery, require healthy workmux/tmux sources, re-read Git safety state and
fresh required provider evidence, and compare the evidence key. Hold the lock
until removal finishes. Never hold a parent sweep lock while waiting for a
child operation that needs that same lock.

Changed/blocked rows become `skipped` with a reason and require a fresh scan;
continue independently safe rows. Known failures become `failed`. Timeout,
truncated output, or ambiguous process termination becomes `unknown`; never
retry automatically. Report native errors and preserve any partial outcome.
Success additionally verifies the exact worktree is absent; branch retention
or deletion must match the chosen mode before reporting full success.

Progress states: pending → running → removed/skipped/failed/unknown. Parent
state is unknown if any item is unknown; otherwise failed if any item is not
removed; otherwise done. Execution is not atomic and provides no rollback.
Browser disconnect does not cancel it; server restart loses the in-memory
registry. Store the active operation ID per browser tab, resume polling on
return, and report “result unavailable; rescan before acting” on a missing ID.

Web locks cannot stop external Git/tmux/agent changes. Narrow the check-to-action
window, rely on native non-force refusal, and document the residual race rather
than claiming a filesystem transaction or cross-process lock.

## 6. UI and delivery

Use one accessible PR/CI component on agent and worktree cards, with PR number,
lifecycle, review text, CI summary, freshness, and a details sheet for returned
check links. Use existing theme tokens and 44px tap targets. Keep `prUrl` as a
compatibility projection of valid PR data while migrating its consumers.

Sweep sheet shows every scanned row, disabled blockers, reason, exact branch,
path, and branch-retention choice. Select-all affects only eligible rows in the
explicit scan scope. Any selection/option change invalidates the prepared token.
Require a separate confirmation of directory/window removal and ignored-file
loss; branch deletion has an additional warning when enabled. Do not emit
success merely because the server returned 202.

Ship phase 1 without the sweep button. Ship phase 2 only after concurrency,
stale-evidence, no-force, and partial-outcome tests pass. Fixture mode never
queries real GitHub and never removes real worktrees; destructive integration
tests use disposable repositories and a dedicated tmux socket only.
