# Commit history browser for the agent view — implementation plan

Date: 2026-11-08
Status: Implemented 2026-11-08 — typecheck 0, 324/324 vitest, build clean, 28/28 e2e, live smoke passed.

## Goal

A **Commits** button in the agent view header (next to the existing Diff
button) opens a list of commits from `git log` for that agent's worktree;
clicking a commit shows its diff.

## Existing pieces this builds on (verified in code)

- `git.ts` already runs `git log --pretty=format:%h%x09%s…%x1e` with
  limit+1 truncation (`unpushedCommits`, ~line 272) — reuse the delimiter
  pattern; `SAFE_REV` (line 215) gates revisions; `parseDiff` (hunks.ts)
  turns unified diff text into `ParsedFile[]`; `diffWip/diffBranch` share a
  byte-capped read (BOUNDS.maxDiffBytes).
- `DiffView` fetches `api.diff(worktreeId, mode)` with a WIP/Review toggle;
  App routes are a discriminated union incl. `{ view: 'diff', … }`.
- `AgentView` header already has `onOpenDiff(agent.worktreeId, label)`.
- Drift harness (`docs.spec.test.ts`) will REQUIRE the new endpoints to be
  added to `docs/SPEC.md` §3 — same-commit doc update is enforced.

## Design decisions (defaults; flag if wrong)

1. **Two read endpoints** (GET — no mutation header needed, host/origin
   gates still apply):
   - `GET /api/worktrees/:id/commits?limit=` → `{ commits: CommitInfo[],
     truncated }`; default 50, hard cap 200 (new `BOUNDS.maxCommits`).
   - `GET /api/worktrees/:id/diff?mode=commit&sha=<rev>` — extends the
     audited diff route rather than a new path (same response envelope).
2. **`DiffMode` gains `'commit'`**; `DiffResponse` gains optional
   `commit?: CommitInfo` (sha/author/date/subject) for the view header.
   Pending lists are empty in commit mode; `pendingKnown` stays source-based.
3. **sha validation**: `SAFE_REV` **plus** reject `..` (range syntax) →
   400 `invalid_request`. `@`/`{` are already excluded by SAFE_REV.
4. **Commit diff = diff vs first parent** (`git diff --find-renames <sha>^
   <sha>`), which renders identically to the existing file/hunk UI; merge
   commits therefore show their change against parent 1. Root commit (no
   parent, detected via `rev-parse --verify <sha>^` failing) falls back to
   `git show --format= <sha>` (diff against empty tree). `--format=` keeps
   metadata out of the parse stream.
5. **Commit list = `git log HEAD`** for the worktree (current branch
   history, newest first). Unborn repo / zero commits → empty list, not an
   error. Rows: short sha, subject, author, relative time. No push-state
   markers in v1 (would need an extra `unpushedCommits` call — noted as
   follow-up candidate).
6. **Navigation**: new route `{ view: 'commits', worktreeId, label }` +
   `CommitsView` (list, mobile sheet-style like PendingChanges sections).
   Clicking a commit opens the existing `DiffView` with `commit` context;
   DiffView's back button returns to the commits list when opened from
   there (route carries `from: 'commits'`).

## Change map (single implementer, sequential)

| # | File | Change |
|---|---|---|
| 1 | `shared/types.ts` | `CommitInfo { sha, short, author, dateSecs, subject, isMerge }`; `CommitListResponse { commits, truncated }`; `DiffMode += 'commit'`; `DiffResponse.commit?: CommitInfo` |
| 2 | `server/adapters/git.ts` | `commitList(cwd, limit)` (log `%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P%x1e`, limit+1 truncation, unborn→empty); `commitDiff(cwd, sha)` (SAFE_REV + no `..`; parent diff; root-commit fallback; byte-cap like diffWip) |
| 3 | `server/config.ts` | `BOUNDS.maxCommits = 200`, `DEFAULT_COMMITS = 50` |
| 4 | `server/services/management.ts` | `commits(targetId, limit)` (target revalidate; dependency errors propagate); `diff()` accepts mode `'commit'` + sha param, attaches `commit` info via `git show -s --format=…` |
| 5 | `server/index.ts` | `/commits` route (zod query: limit int 1..maxCommits); extend `DiffQuery` with `mode: z.enum(['wip','branch','commit'])` + `sha` (required iff commit; SAFE_REV/`..` check → 400) |
| 6 | `src/lib/api.ts` | `commits(worktreeId, limit?)`, `diff(worktreeId, mode, sha?)` (reads: keep 15 s deadline) |
| 7 | `src/App.tsx` | Route variant `commits` + render `CommitsView`; diff route carries optional `commit` + `from` |
| 8 | `src/features/agent/AgentView.tsx` | **Commits** button in header (disabled when `git === null`), `onOpenCommits(worktreeId, label)` |
| 9 | `src/features/worktrees/CommitsView.tsx` (new) | Header + list rows (short sha mono, subject, author · relative date, merge glyph); click → open commit diff; empty state "no commits yet"; `stale` degradation like dashboard |
| 10 | `src/features/worktrees/DiffView.tsx` | Optional `commit` prop: mode `commit` (hide WIP/Review toggle, pending section, Commit-now box), header shows `short · subject`; back honors `from: 'commits'` |
| 11 | Tests | see Verification |
| 12 | Docs | `docs/SPEC.md` §3 endpoint rows + §8 UI line (**required — drift harness fails otherwise**), README bullet, canonical amendment, README/AGENTS counts, plan status flip |

Dependencies: 1 → 2/3 → 4 → 5 → 6 → 7/8/9/10 → 11 → 12.

## Verification

- **Adapter** (`git.test.ts`, real temp repo): list ordering/limit/truncated;
  unicode + tab-free subject round-trip via `%x1f` delimiters; merge commit
  `isMerge` + parent-1 diff; root commit fallback; `..` and flag-like revs
  rejected; unborn repo → empty list.
- **Service** (`management.commit.test.ts` harness): commits happy path +
  unknown target throws `TargetNotFoundError`; diff mode commit attaches
  `commit` metadata; invalid sha → BadRequestError.
- **Route** (`security.routes.test.ts`): `/commits` unknown id → 404
  `target_not_found` (GET — no header needed); `mode=commit` without sha →
  400; sha with `..` → 400.
- **UI** (`CommitsView.test.tsx` new + `DiffView.test.tsx`): list renders
  rows, click calls `api.diff(id,'commit',sha)`; commit-mode DiffView shows
  subject, hides WIP/Review toggle + Add/Commit affordances; back returns to
  list; AgentView Commits button disabled when git null.
- **E2e** (`commit-untracked.spec.ts` or new spec): fixture-mode graceful
  contract — commits on non-repo fixture path → 502 `dependency_error`;
  `mode=commit&sha=..x` → 400.
- **Gate**: `npm run typecheck && npm test && npm run build &&
  npm run test:e2e` + live read-only smoke of both endpoints against the
  real repo on a spare port (never the user's :3000, never a mutation).

## Out of scope

- Push-state markers per commit row; bisect/revert/cherry-pick actions;
  commit search; worktree-card Commits entry (agent view only, per request);
  ref-graph/branch list.
