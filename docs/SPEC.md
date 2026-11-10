# workmux-http — Current-State Specification

Status: living document. This file describes **what the system does today**.
The chronological decision trail lives in `docs/superpowers/plans/`
(amendments) and per-feature plans — those explain *why*; this explains
*what is*. Resolve conflicts using the distinction and precedence below.

**Precedence on conflict:** code and tests establish observed behavior.
User-approved requirements establish intended behavior. A conflict is a
finding to resolve, not permission to rewrite the requirement.
For conflicting documents: SPEC.md > latest canonical amendment > AGENTS.md
conventions > README.md > dated feature plans. This hierarchy does not
override explicit user requirements.

**Drift harness:** `server/docs.spec.test.ts` machine-checks the tables
below against `server/index.ts`, `server/config.ts`, and `server/security.ts`,
and validates the invariant-to-test mapping against declared tests in the
normal `npm test` run. Missing mappings and renamed/deleted test references
fail the suite, as do routes/env vars/error codes changed without updating
this file.

## 1. System model

- Single Node.js (≥ 22, ESM) process on the same Mac as workmux/tmux.
  Fastify 5 serves the API, the WebSocket, and the built SPA from **one
  origin** (no CORS by design; dev splits :3000 API + :5173 Vite).
- The backend orchestrates three binaries — `tmux`, `workmux`, `git` —
  exclusively through `server/exec.ts` (argv-only `execFile`, never a
  shell, bounded timeout/output). This is the sole subprocess gateway.
- Frontend: React 19 hooks-only SPA, no router library (route = discriminated
  union in `App.tsx`), Tailwind v4 `@theme` tokens.
- `shared/types.ts` is the single source of API contracts (field-level
  schemas live there, not in this document).
- Discovery (`server/services/discovery.ts`) snapshots workmux+tmux+git
  every poll with a 2 s TTL cache, in-flight dedupe, last-good retention,
  and per-source `stale` markers. Degrade with `stale`, never fabricate
  empty data.

## 2. Security model (no login by design)

The network boundary is the security boundary: VPN/loopback only. Three
request gates run as a `preHandler` hook, classified by
`req.routeOptions.url` (router-resolved, so percent-encoded prefixes cannot
skip them):

1. **Host allowlist** — `Host` must match `WORKMUX_ALLOWED_HOSTS`
   (port-exact comparison). `*` opt-in (`cfg.allowAnyHost`) accepts any
   Host and is DNS-rebinding exposed; never the default.
2. **Origin check** — for requests carrying `Origin`, scheme+host+port must
   equal the request target (port-exact).
3. **Mutation header** — every non-GET `/api/*` requires
   `x-workmux-request: 1` (blocks simple cross-site form/CORS-less posts).

Wildcard binds (`0.0.0.0`, `::`) are refused at startup unless
`WORKMUX_HTTP_ALLOW_WILDCARD=1`; the Host allowlist stays enforced either
way. Static SPA responses: HTML is `no-cache`, hashed assets immutable.

## 3. HTTP API

<!-- check:routes -->
| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness + config summary |
| `GET /api/dashboard` | full snapshot: agents, worktrees, sources, `stale` |
| `GET /api/projects` | known projects (for create form) |
| `GET /api/agents/:id/output` | captured pane text (reader mode) |
| `POST /api/agents/:id/messages` | literal message delivery (paste-buffer + Enter) |
| `POST /api/agents/:id/keys` | explicit key strokes |
| `GET /api/worktrees/:id/diff` | `mode=wip\|branch\|commit`; files + pending lists; commit mode takes `&sha=` (SAFE_REV, no `..`) |
| `GET /api/worktrees/:id/commits` | `git log` list (`CommitInfo[]`, newest first, limit ≤ 200) |
| `POST /api/worktrees/:id/hunks/:action` | `stage\|unstage\|split` one hunk/piece |
| `POST /api/worktrees/:id/add` | stage exact paths (`AddResult`) |
| `POST /api/worktrees/:id/unstage` | unstage exact paths (`AddResult`) |
| `POST /api/worktrees/:id/commit` | run kind's commit command (async op) |
| `POST /api/worktrees/:id/hunk-comments` | attach review comment to a hunk |
| `POST /api/worktrees` | create worktree + window (async op) |
| `POST /api/actions/prepare` | mint single-use confirm token for merge/push/remove/stop |
| `POST /api/actions/execute` | consume token, run action (async op) |
| `POST /api/sweeps/scan` | collect clean-sweep evidence (async op `sweep-scan`, 202) |
| `POST /api/sweeps/prepare` | re-verify selection against fresh evidence, mint sweep token |
| `POST /api/sweeps/execute` | consume sweep token, non-force removals (async op, 202) |
| `GET /api/operations/:id` | operation registry view |
| `WS /api/terminal` | advanced terminal (owned sessions only) |

Conventions: ids are opaque (`wt_<sha1[:12]>`, tmux `%N` — URL-encoded on
the wire); every mutation body carries a client `requestId` (dedupe for
messages; pane-scoped). Reads use a 15 s client deadline; mutations
deliberately have none (aborting a possibly-applied mutation would fabricate
unknown delivery). Create/execute/commit and sweep scan/execute return **202**
with `operationId`; poll `GET /api/operations/:id`. Sweep bodies are strict
(unknown fields rejected); they never accept paths, `force`, or client-supplied
evidence.

<!-- check:errors -->
Error envelope `{ error, detail?|message? }`:

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | zod body/param failure (incl. uncaught ZodError handler) |
| `bad_request` | 400 | domain rejection (e.g. `nothing_to_commit`) |
| `unknown_hunk_action` | 400 | `:action` outside stage/unstage/split |
| `forbidden_host` | 403 | Host not allowlisted |
| `cross_origin` | 403 | Origin mismatch |
| `missing_request_header` | 403 | mutation without `x-workmux-request` |
| `target_not_managed` | 404 | id not in current managed targets |
| `target_not_found` | 404 | unknown worktree/agent id |
| `operation_not_found` | 404 | no such operation id |
| `not_found` | 404 | unmatched `/api/*` path |
| `confirmation_required` | 409 | prepare needed / token invalid or consumed |
| `snapshot_stale` | 409 | diff `snapshotId` superseded (hunk ops); sweep scan expired, selection drifted, or evidence changed |
| `sweep_busy` | 409 | a sweep scan or sweep is already running (one at a time) |
| `target_gone` | 410 | target vanished mid-operation |
| `delivery_unknown` | 502 | message delivery ambiguous — never auto-retried |
| `dependency_error` | 502 | tmux/workmux/git binary failed |
| `internal` | 500 | route-level unexpected |
| `internal_error` | 500 | global error handler fallback (detail-free) |

Per-path rejections (add/unstage/commit) return **200** with
`{ ok: false, message, offenders }` — a validated request whose paths went
stale is not an HTTP error.

## 4. Core invariants

<!-- check:invariants -->
1. **INV-01 — Managed-only targets**: mutations revalidate ids against
   `discovery.agentTargets()` / `worktreeTargets()` at execution time.
2. **INV-02 — Single-use confirm tokens**: consumed synchronously and
   checked for expiry at execute; the state key is re-evaluated inside the
   lock. Execute never trusts prepare-time state.
3. **INV-03 — Per-target locks span operation completion** (`Operations.settled`):
   commit/add/unstage/hunk/merge/remove/push/sweep serialize by worktree id;
   stop serializes by pane id. These locks cover web mutations only.
4. **INV-04 — Shared tmux geometry and ownership**: Reader/input/Terminal
   attach never select or resize shared windows. Navigation uses owned
   grouped sessions `wmhttp-adv-*` marked `@wmhttp_owned`; cleanup
   double-checks the marker. Explicit confirmed Terminal resize is the
   documented exception and affects all clients of the shared window.
5. **INV-05 — Never auto-retry ambiguous delivery** (`UnknownDeliveryError` →
   `delivery_unknown` 502).
6. **INV-06 — Degrade, never fabricate**: source failure ⇒ last-good + `stale`
   markers; empty data only when genuinely empty. Optional GitHub PR/CI
   failure is disclosed on the PR/CI component only — it never marks core
   sources failed and never claims the tmux connection is offline.
7. **INV-07 — Conflicts are awareness-only**: `u` paths listed, never auto-added,
   never restorable via unstage.
8. **INV-08 — Repo-controlled revisions gated by `SAFE_REV`** before any diff/
   merge of attacker-influenced refs.
9. **INV-09 — Stale writes blocked**: hunk ops carry `snapshotId`; superseded ⇒
   `snapshot_stale`.
10. **INV-10 — Data freshness** for the banner = `deriveConnection(snapshot, error,
    lastOkAt)` (source health + polling), **never** `snapshot.stale` alone
    (idle agents are per-agent badges, not a connection problem). GitHub
    status carries its own per-key freshness: successes serve 60 s then
    render `stale` while refreshing; failures retry after 15 s; cache keys
    include the exact HEAD oid so a prior commit's CI never labels a new one.
11. **INV-11 — Terminal is session-wide and honestly disclosed**: attach validates
    the requested pane but tmux focus is per-window; `attached.activePaneId` +
    2 s watchdog emit `pane-changed` and the UI names the keystroke target.

### Invariant-to-test mapping

Use stable IDs in specification deltas and review findings. IDs are never
renumbered or reused; new invariants receive a new ID. References use
repository-relative `file::literal test title` and must name a direct
`test(...)` or `it(...)` declaration. Run the referenced files with
`npx vitest run <file> ...` for focused verification, then the full gate.

The drift harness checks mapping completeness and test declarations. It
does not establish assertion quality, execution, or passing results.
Skipped integration tests are not live evidence; record missing dependencies
and any applicable gap below when reporting verification.

<!-- check:invariant-tests -->
| Invariant | Regression tests | Coverage limits / gaps |
|---|---|---|
| `INV-01` | `server/services/input.test.ts::should reject unmanaged targets`<br>`server/services/management.commit.test.ts::should 404 for unmanaged worktrees`<br>`server/services/discovery.test.ts::should not treat kind-less panes as message targets`<br>`server/services/sweep.test.ts::should reject unmanaged sweep targets`<br>`server/services/sweep.test.ts::should force-refresh discovery for evidence and reject vanished targets` | Rejection and discovery filtering are covered; no dedicated regression for a target disappearing while its mutation is queued. Sweep targets are additionally revalidated against a forced discovery refresh at execute. |
| `INV-02` | `server/services/management.hunks.test.ts::should reject a second execute of the same token`<br>`server/services/management.hunks.test.ts::should let exactly one of two concurrent executes through`<br>`server/services/management.hunks.test.ts::should reject execute once the token TTL elapsed even without a later prepare (F08)`<br>`server/services/management.push.test.ts::should reject execute when HEAD moved after prepare`<br>`server/services/sweep.test.ts::should consume sweep tokens before concurrent execution`<br>`server/services/sweep.test.ts::should skip remaining rows when the token expires mid-execution` | Single use, expiry, and HEAD drift are covered; no exact TTL-boundary or state-changing-queued regression. Sweep re-checks token expiry per row and re-verifies frozen evidence keys before each removal. |
| `INV-03` | `server/services/management.hunks.test.ts::should serialize executes for one target until the first operation settles (F03)`<br>`server/services/target-locks.test.ts::should hold a worktree lock until its returned operation settles`<br>`server/services/target-locks.test.ts::should serialize a sweep callback behind a management operation`<br>`server/services/sweep.test.ts::should not hold the parent operation while a target lock is busy` | Shared TargetLocks coordinator covered for job-return vs operation-settlement and cross-service serialization. External CLI/agent mutations are outside the web lock. |
| `INV-04` | `integration/tmux.integration.test.ts::should capture and send without changing active window/pane or size elsewhere`<br>`integration/tmux.integration.test.ts::should keep grouped session window selection independent from parent`<br>`integration/tmux.integration.test.ts::should refuse to kill sessions lacking the ownership marker`<br>`integration/tmux.integration.test.ts::should attach at exact pane size, resize only when asked, and clean up`<br>`src/features/terminal/TerminalView.test.tsx::resize button opens a confirm dialog; cancel sends nothing` | Real-tmux checks require tmux; the geometry check also requires native node-pty and can skip. The confirmation UI uses mocks; physical Safari is not covered. |
| `INV-05` | `server/services/input.test.ts::should report unknown delivery on ambiguous failure without retry` | Service-level simulated failure; no HTTP 502 regression or real disconnect during paste/Enter. |
| `INV-06` | `server/services/discovery.test.ts::should mark source errors and stay stale when tmux fails, keeping last good data`<br>`server/services/discovery.test.ts::should treat empty observations as valid empty snapshot`<br>`src/features/agent/OutputPane.test.tsx::keeps the last snapshot and shows a notice on transient failure, then recovers`<br>`server/services/discovery.test.ts::should join service status without blocking the snapshot build`<br>`src/components/PrCiStatus.test.tsx::discloses unavailable and loading states without claiming offline`<br>`server/services/sweep.test.ts::should skip rows whose sources degraded before removal` | tmux and Reader failure paths are covered; not every discovery-source failure combination. GitHub failure coverage is fixture/mock-level (no live rate-limit proof). Sweep treats unverifiable evidence as a blocker, never as clean. |
| `INV-07` | `server/adapters/git.test.ts::should list unmerged paths as conflicts` | Partial: conflict listing is covered; no dedicated service regression for conflict exclusion from bulk add and unstage. |
| `INV-08` | `server/adapters/git.test.ts::should reject unsafe revisions`<br>`server/security.routes.test.ts::rejects range syntax in the sha parameter`<br>`server/adapters/sweep-git.test.ts::should flag refs that fail SAFE_REV`<br>`server/adapters/sweep-git.test.ts::should never execute hostile remote helper urls` | Commit-diff rejection is covered; no dedicated hostile .workmux.yaml base or merge-ref regression. Sweep base resolution and remote queries refuse unsafe refs and `ext::`-style remotes. |
| `INV-09` | `server/services/management.hunks.test.ts::should reject stale snapshots without touching the index`<br>`server/services/management.hunks.test.ts::should reject foreign patch text as piece` | Real temporary git index checks; no dedicated HTTP snapshot_stale status regression. |
| `INV-10` | `src/hooks/useDashboard.test.ts::is online when all sources are healthy even if agents are idle-stale`<br>`src/hooks/useDashboard.test.ts::is stale when some sources failed`<br>`src/hooks/useDashboard.test.ts::is stale when polling stalled past the timeout`<br>`src/hooks/useDashboard.poll.test.ts::reports online immediately after resume (no stale flash)`<br>`server/services/github-status.test.ts::should preserve last good PR data with a stale marker`<br>`server/services/github-status.test.ts::should discard late completions for departed keys` | Derived-state and mocked polling checks; no real VPN outage or physical Safari background/resume proof. GitHub TTL/backoff verified with fake timers only. |
| `INV-11` | `server/services/terminal.hub.test.ts::reports the window active pane on attach even when it differs from the agent`<br>`server/services/terminal.hub.test.ts::emits pane-changed when the window active pane moves while attached`<br>`src/features/terminal/TerminalView.test.tsx::discloses when the window active pane differs from the agent (F05)` | Hub and UI use mocks; no split-pane live integration check of disclosure updates. |

### GitHub PR/CI visibility (optional overlay)

`WorktreeView.github` carries an optional `GithubStatus`
(`loading | ready | stale | unavailable | unsupported`); agents join the
same status by `worktreeId` (never fetched per agent). `prUrl` remains a
ready-only compatibility projection (`github.state === 'ready' && pr`).

Identity (server-resolved from local git config only, github.com):
head repo = GitHub tracking remote for the branch → GitHub `origin` → sole
GitHub remote (multiple = `unavailable`/ambiguous). Base repo = GitHub
`upstream` remote → fork parent (GraphQL, resolved off the critical path;
failure = unavailable, never guessed) → head repo. PRs match exact head
repository + branch; unique open + exact HEAD wins, else single open
(labeled head-differs) or most recent closed/merged (labeled). Multiple
matches or a capped list = ambiguous, never arbitrary selection.

CI is for the exact local HEAD oid via `statusCheckRollup` pagination
(CheckRun + StatusContext). Honesty rules: unknown/incomplete never renders
as passing; null rollup, per-field GraphQL errors, and unpublished commits
are `unknown`; a successful empty set is `none`; neutral/skipped are counted
separately and cannot turn a badge green; all-green does not mean mergeable.

Refresh: shared service (60 s success TTL, 15 s failure backoff, 4
concurrent, queue 100, cache 1000, in-flight dedup), keys =
repos + branch + HEAD oid; departed keys pruned and late results dropped.
Discovery schedules reads and never awaits the network; GitHub failure
never affects `sources` or `deriveConnection` (INV-06/INV-10 extension).
Requires the `gh` CLI; fixture mode serves `fixtures/github-status.json`
(missing entry = unavailable, never a live fallback).

### Clean sweep (confirmed, non-force)

`POST /api/sweeps/scan {worktreeIds, requestId}` starts an async
`sweep-scan` operation collecting per-target evidence (git facts via
`SweepGit`, live agent panes, open windows, fresh GitHub PR state). Every
requested id appears in the result — inspection failures surface as
blockers, never as omissions. Candidates carry a cleanup `reason`
(`pr_merged | pr_closed | upstream_gone | merged_locally`) plus
independent `blockers`; the scan record lives server-side for 300 s
(`scanId` = scan operation id).

`POST /api/sweeps/prepare {scanId, worktreeIds, keepBranches, requestId}`
requires a stored, unexpired scan, an exact subset of eligible rows, then
re-reads all evidence (forced discovery refresh + git + fresh PR) and
re-classifies with the chosen `keepBranches`. Any drift ⇒ `snapshot_stale`
(rescan). Warnings (ignored-file deletion always; open windows; branch
deletion when `keepBranches` is false) require explicit acknowledgement at
execute. The single-use token binds the exact selection, per-row evidence
keys, and the keep/delete-branches choice; TTL 300 s.

`POST /api/sweeps/execute` validates capacity (one sweep + one scan at a
time ⇒ `sweep_busy`), ack, expiry, then consumes the token synchronously
before the first await (requestId dedupe: same payload → same operation;
reuse with a different payload ⇒ 400). Per target, under the shared
per-worktree lock: expiry re-check → forced-refresh evidence → blockers
re-evaluated → evidence-key match → `workmux remove` with
**`force: false`** (no force path exists) and `keepBranch` =
`keepBranches` (native `--keep-branch`). Exit 0 still requires the
postcondition (directory gone; branch present/deleted per mode) to count
as `removed`; exit 1 with output = known refusal (`failed`); timeout,
truncated output, or unconfirmed success = `unknown` — never retried.
Rows continue independently past failures. Parent state: any `unknown` ⇒
`unknown`; else any non-removed ⇒ `failed`; else `done`. Fixture mode
refuses all sweep endpoints (400) — it never removes real worktrees.

## 5. State machines

**Confirm token**: `prepare(action,target)` → `{token, targetLabel,
warnings, stateKey}` → user ack → `execute(token)` — consumed once;
expired TTL ⇒ `confirmation_required`; state key changed since prepare ⇒
re-confirm.

**Operations registry**: `running` → `done | failed`; `settled(id)` resolves
at completion (locks release then); settled ops pruned past retention.
Sweep operations add `unknown` as a terminal state (ambiguous removals).

**Clean sweep**: scan op `running → done` (record TTL 300 s) → prepare
(drift ⇒ `snapshot_stale`, token TTL 300 s) → execute consumes token →
per-item `pending → running → removed | skipped | failed | unknown`;
parent `running → done | failed | unknown` (any unknown ⇒ unknown; else
any non-removed ⇒ failed). No item is ever retried.

**Connection (client)**: `online | stale | offline` derived from source
health + poll success recency; polling pauses when a tab is hidden or the
advanced terminal owns the pane.

**Diff pending model** (`mode=wip`): `untracked[]`, `unstaged[]`,
`staged[]` (index vs HEAD, conflicts excluded), `conflicts[]`,
`hasStaged`, `pendingKnown` (false ⇒ status source failed; UI hides
action affordances rather than showing empty).

## 6. WebSocket protocol (`/api/terminal`)

Client→server: `attach {paneId}` · `input {data}` · `fit {cols,rows}` ·
`detach`. Server→client: `attached {cols,rows,activePaneId}` · `output` ·
`resized` · `pane-changed {activePaneId}` · `detached` · `error {message}`.

Refused in fixture mode. Capacity: `WORKMUX_HTTP_MAX_OWNED_TERMINALS`,
reserved synchronously at attach (pending counts); close/detach/reattach
cancels in-flight attaches by generation (cancelled attach kills its owned
session + PTY). Grid changes only on `resized` ack; fit proposals measure
the visible viewport, never the expanded grid.

## 7. Configuration

<!-- check:env -->
| Variable | Default | Effect |
|---|---|---|
| `WORKMUX_HTTP_BIND` | `127.0.0.1` | listen address; wildcard refused without opt-in |
| `WORKMUX_HTTP_PORT` | `3000` | listen port |
| `WORKMUX_HTTP_ALLOW_WILDCARD` | unset | `1` permits wildcard bind (Host allowlist still enforced) |
| `WORKMUX_ALLOWED_HOSTS` | `localhost` | comma Host allowlist, port-exact; `*` = any (dangerous) |
| `WORKMUX_TMUX_SOCKET` | tmux default socket | explicit socket path |
| `WORKMUX_REPOS` | none | extra repo paths for discovery |
| `WORKMUX_HTTP_FIXTURES` | none | fixture mode from a fixtures dir (no live tmux/workmux; terminal refuses) |
| `WORKMUX_HTTP_STALE_AFTER` | `3600` | agent idle seconds before `stale` |
| `WORKMUX_HTTP_MAX_OWNED_TERMINALS` | `4` | concurrent owned terminal cap |
| `WORKMUX_COMMIT_TIMEOUT_MS` | `300000` | commit command timeout |
| `WORKMUX_PUSH_TIMEOUT_MS` | `120000` | push command timeout |
| `WORKMUX_<KIND>_COMMIT_CMD` | none | direct-commit command per agent kind (`{{COMMIT_MSG}}` placeholder, quote-context escaped; OMP≡OPENCODE alias) |
| `WORKMUX_<KIND>_PUSH_CMD` | none | direct-push command per agent kind |

## 8. UI capability inventory (behavioral, not visual)

- **Dashboard**: agents/worktrees tabs, search/sort/filters (agent search
  matches project, name, and branch), per-agent branch label (when git info
  is available), per-agent
  pending badge (`●N`), unpushed indicator, connection banner, PR/CI status
  badges (PR number/state/review link + CI rollup badge with counts, check
  list, stale age, honest unknown/unavailable/unsupported disclosure;
  rendered outside card navigation buttons).
  Only workmux records with a recognized `agent_kind` are listed; kind-less
  panes (plain shells, dev servers) are filtered out of both the agent
  list and message targets.
- **Agent view**: reader mode (captured output, opens at tail, captured
  padding stripped, line-layout cycle wrap/fit/scroll — wrap indents
  soft-wrapped continuations, fit shrinks the font so full lines fit the
  screen width) ↔ terminal
  mode (live WS, mode header, pane-target warning); composer + explicit
  keys; session switcher; previous-agent action; **Commits** button (hidden
  git-less) opening the commit-history list (`/commits`), where each row
  opens that commit's diff vs first parent (read-only DiffView: no mode
  toggle, no pending section, no footer actions).
- **Diff view**: file sidebar, wip/branch modes, hunk stage/unstage/split +
  comments, pending-changes section (Add ↔ Restore flip per staged state,
  Add all / Restore all), Commit-now box (disabled when clean), push button
  with commit-body review + per-action ack.
- **Worktrees**: create form (project/branch/prompt/profile), merge/remove/
  stop behind exact-target confirm dialogs.
- **Palette + shortcuts**: Alt+←, Esc, `:`, ⌘P, `/`, j/k, 1-9.
- Mobile-first: 44px tap targets, iOS zoom-guard inputs, `dvh` layouts,
  `md:` = iPad.

## 9. Verification gate

`npm run typecheck && npm test && npm run build && npm run test:e2e`, plus a
live read-only smoke (`/api/health`, `/api/dashboard`) when touching server
paths. Exact test counts live in README/AGENTS (deliberately **not** here —
they drift every feature). This file's tables and invariant-to-test mapping
are checked by `server/docs.spec.test.ts`.

## 10. Doc map

| File | Role |
|---|---|
| `docs/SPEC.md` | **this file** — current state |
| `docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md` | canonical spec + additive amendments (decision trail) |
| `docs/YYYY-MM-DD-*-plan.md` | per-feature pre-implementation plans (historical) |
| `docs/2026-11-08-project-audit.md` | security/robustness audit (all findings closed) |
| `AGENTS.md` | agent-facing conventions + invariants summary |
| `README.md` | user-facing setup, env table, VPN model |

Maintenance rule (also in AGENTS.md): any change to routes, env vars, error
codes, invariants, WS protocol, or state machines MUST update this file in
the same commit; the drift harness enforces the enumerable subsets and
validates the test references, not the semantic coverage of their assertions.
