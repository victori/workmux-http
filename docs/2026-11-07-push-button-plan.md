# Push Button + Unpushed-Commit Indicator — Implementation Plan

Date: 2026-11-07
Status: Implemented (2026-11-07). Verification: 222 vitest (git adapter +4, push integration +7 vs local bare remote, AgentCard jsdom +6), 25 Playwright e2e, typecheck + build clean, live read-only smoke (real fleet: ahead counts on agents, prepare returned 3-commit review list; no push executed against real remotes). Canonical amendment: docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md § "Push button + unpushed indicator".

## Goal

When an agent's worktree has commits not present on its remote (unpushed),
the agent's main card on the dashboard shows:
1. a badge with the **count of pending commits** (`↑N`), and
2. a **Push** button whose confirmation dialog lists the **commit messages
   subject lines** so the operator reviews exactly what will be published
   before approving.

## Facts already available (reuse, do not rebuild)

- `git.repoStatus` (`server/adapters/git.ts:51`) parses `## branch...origin/x [ahead 2, behind 1]`
  → `RepoStatus.ahead` **is** the unpushed count; `behind` = divergence.
- `discovery.gitInfoFor()` already runs `repoStatus` per workdir with a TTL
  cache (`gitCache`, `BOUNDS.gitTtlMs`) — agents carry `git: GitInfo | null`.
- Destructive-action pattern exists end to end: `management.prepare/execute`
  with single-use confirm tokens bound to `action+target+state key`,
  revalidation at execute, `operations.start(...)` async + poll,
  `ConfirmDialog` UI, `WorktreeCard` card-local flow
  (`src/features/dashboard/WorktreeCard.tsx:45-62`) to mirror for AgentCard.
- `ActionType` union (`shared/types.ts:215`) + generic routes
  `POST /api/actions/prepare|execute` — adding `'push'` needs **no new route**.

## Decision record (defaults chosen; flag if you disagree)

- **No-upstream branches**: push is allowed with an extra warning
  (`creates remote branch origin/<branch> and sets upstream`); executed as
  `git push -u origin <branch>`. Alternative (block until upstream exists)
  rejected — mobile ergonomics; the warning is the review point.
- **Diverged (behind > 0)**: warning, not block. The remote will reject a
  non-fast-forward push anyway; the server NEVER sends `--force`/`--force-with-lease`
  under any setting. stderr is surfaced so the operator merges first.
- **Zero ahead / unborn / no origin remote**: `blocked` in prepare (button
  hidden client-side anyway; server is authoritative).
- **Review-before-approve**: `PreparedAction` gains `commits?: CommitEntry[]`
  (`{ sha: short, subject }`), capped (`maxPushCommitsList = 20`, plus
  `+N more` line). Token key includes the current HEAD sha + ahead count so
  new commits made after prepare force a re-confirmation ("target state
  changed").
- **Timeout**: new `WORKMUX_PUSH_TIMEOUT_MS`, default 120000 (network-bound).
- **Badge placement**: agent card (requested) AND worktree card (same data,
  one-line cost); badge is `↑N` with `title="N unpushed commits"`.

## shared/types.ts (contract first)

- `GitInfo`: add `ahead: number | null`, `behind: number | null`
  (null = no upstream configured; keep `hasUnmergedCommits` as-is for
  compatibility with existing badge logic — rename deferred, it is
  consumer-visible).
- `WorktreeView`: add `unpushed: number | null`.
- `ActionType`: add `'push'`.
- `PreparedAction`: add `commits?: Array<{ sha: string; subject: string }>`.

## server/adapters/git.ts (+ git.test.ts)

- `unpushedCommits(cwd, limit): Promise<Array<{ sha, subject }>>` —
  upstream: `git log --pretty=format:%h%x09%s <up>..HEAD`; no upstream:
  `origin/<branch>..HEAD` when `origin/<branch>` exists
  (`git show-ref --verify --quiet`), else all commits vs nothing
  (`HEAD` list capped, first-push case).
- `push(cwd, branch, setUpstream, timeoutMs): CommitRun`-shaped result —
  argv: `git push` (+ `-u origin <branch>` when no upstream else plain
  `git push`). Never any force flag. Uses exec.run (group-kill, stdin EOF).
- Tests: real-git temp repo + **local bare remote** (clone → commit →
  ahead=1 → log entries; push → remote log matches; first-push sets
  upstream; diverged push exits non-zero with hint, no force sent).

## server/services/discovery.ts (+ config.ts)

- `gitInfoFor`: pass through `ahead`/`behind` (null when the `##` header had
  no `[ahead …]` segment = no upstream).
- Worktree view build: attach `unpushed` from the same cached `repoStatus`
  (no extra git calls; cache already keyed per workdir).
- `config.ts`: `pushTimeoutMs` + `BOUNDS.maxPushCommitsList = 20`,
  `pushTimeoutMs` default 120000, env `WORKMUX_PUSH_TIMEOUT_MS`.
- Fixture mode: `gitInfoFor` returns null → badge hidden (degrade, don't
  fabricate — existing rule).

## server/services/management.ts (+ management.push.test.ts)

- `evaluateAction` case `'push'`:
  - target must be a managed worktree (existing revalidation);
  - fresh `repoStatus` (not cached snapshot): `blocked: 'nothing to push'`
    when `ahead === 0` (and upstream exists); unborn → blocked; no `origin`
    remote (`git remote get-url origin` fails) → blocked;
  - warnings: `behind > 0` → `remote has N newer commits — push will be
    rejected until you merge`; no upstream → first-push warning; uncommitted
    changes → informational warning (push only sends commits);
  - key: `push\u0000<wtId>\u0000<headSha>\u0000<ahead>` — drift between
    prepare and execute ⇒ `ConfirmationError` (existing mechanism).
- prepare response for `'push'`: attach `commits` via
  `git.unpushedCommits(wt.path, BOUNDS.maxPushCommitsList)`.
- `runAction` case `'push'`: `operations.start('push', label, …)` →
  `git.push(...)`; non-zero exit → `error: push failed (exit N): <out tail>`;
  success output includes the pushed ref line.
- Integration tests (real git + local bare remote): prepare lists commits +
  token; execute pushes and remote log matches; new commit between prepare
  and execute → ConfirmationError; ahead 0 → blocked; behind>0 →
  unacknowledged-warnings path; no-origin → blocked.

## Frontend (src/)

- `src/lib/api.ts`: no new methods (prepare/execute generic); types flow
  from shared.
- `src/features/dashboard/AgentCard.tsx`: footer gains
  `↑N` badge + `Push` button (44px rule) when `agent.git?.ahead` > 0;
  card-local flow mirroring WorktreeCard: `api.prepare({action:'push',
  targetId: agent.worktreeId})` → dialog → `api.execute` (token,
  acceptWarnings) → poll `api.operation` at 1s → inline note
  (`pushed` / error tail). Hidden entirely when ahead is 0/null/unavailable.
- `src/components/ConfirmDialog.tsx`: render `prepared.commits` list
  (mono, `sha subject`, one per line, `+N more` when capped) between
  target label and warnings; `role="list"`.
- `src/features/dashboard/WorktreeCard.tsx`: `↑N` badge only (no button —
  push lives on the agent card per request; avoid two push entry points).
- DashboardView passes `onOpenDiff`-style callbacks unchanged; AgentCard
  gains no new required props beyond existing data (git is on AgentView).
- jsdom tests (DashboardView.test.tsx or new AgentCard.test.tsx):
  badge renders `↑2`; button hidden when ahead 0/null; click →
  api.prepare called with `['push', worktreeId]`; dialog shows commit
  subjects; execute + poll success → note; failure → inline error.

## Security invariants (must hold)

- Push target derived ONLY from server-side git metadata (upstream /
  origin/<branch>); request bodies carry action+target+token, nothing else.
- No force-push code path exists, ever; divergence is the remote's problem.
- Confirm token consumed synchronously + state key revalidated at execute
  (HEAD sha + ahead count ⇒ review list cannot silently go stale).
- All push traffic through `exec.run` (argv-only, group kill, stdin EOF).
- Managed-target rule unchanged.

## Verification gate

- `npm run typecheck && npm test && npm run build && npm run test:e2e`
- New tests: git adapter (~4), management push integration (~6), jsdom
  (~5) ⇒ expect ~220 vitest baseline.
- e2e (fixture mode, git unavailable): badge absent, no crash — contract
  test that `prepare {action:'push'}` on a fixture worktree returns a
  structured response (fixture git is null ⇒ blocked path), asserting no
  fabricated badge data.
- Live read-only smoke: `/api/dashboard` shows `unpushed` for a real
  worktree with ahead>0; NO push executed against real remotes in
  verification (bare-remote integration tests prove the push path).

## Out of scope

- Force-push / force-with-lease (by design, never).
- PR creation/merge interplay (existing merge action unchanged).
- Fetch-on-view (ahead/behind reflect last `git status`; remote refs update
  only when something fetches — disclosed limitation, note in README).
- Per-commit checkboxes / selective push (whole branch or nothing).
