# Unstage ("Restore staged") for added files — implementation plan

Date: 2026-11-08
Status: Implemented 2026-11-08 — typecheck 0, 287/287 vitest, build clean, 27/27 e2e.

## Goal

The pending-changes section currently only offers **Add** (stage). Once a
file is added it vanishes from the list with no way back from the UI.
Requirement: staged files stay visible and their button switches from
**Add** to **Restore staged** (unstage: undo the `git add`, keep the file
changes on disk — never delete file content).

## Current behavior (verified in code)

- `server/adapters/git.ts` `repoStatus()` collects `untracked`, `unstaged`,
  `conflicts` — a fully-staged file (`A `/`M `) appears in none of them.
- `Management.addPending()` revalidates paths against a fresh status and
  runs `git add -- …` inside the per-target lock (`locked()`), returning
  `{ ok, offenders }`.
- `POST /api/worktrees/:id/add` (IdParams + `AddBody` zod, mutation-header
  guard inherited from the preHandler hook) → `api.addPaths` →
  `PendingChanges` rows per file + "Add all (N)".
- DiffView reloads the diff after add/commit, so a row-level
  Add → Restore flip comes for free once staged paths are surfaced.
- Gap noted while inspecting: `addPending` never calls
  `discovery.invalidateRepo()` (hunkAction does) — badges stay stale up to
  the 2 s TTL after staging. Fix both paths in this change.

## Design decisions (defaults; flag if wrong)

1. "Remove" = **unstage only** (`git restore --staged -- <path>`); worktree
   content untouched. Wording in UI: button **Restore**, tooltip
   "unstage — keeps file changes".
2. Whole-file Restore complements the existing per-hunk unstage in the diff
   body (hunk UI unchanged).
3. Bulk **Restore all (N)** in the section header, symmetric with Add all.
4. Conflicts stay awareness-only: unmerged paths are never unstaged here
   (`git restore --staged` on `u` entries would be wrong).
5. New endpoint `POST /api/worktrees/:id/unstage` (sibling of `/add`, same
   body schema + `AddResult` response) rather than overloading `/add` with
   an action field — keeps the audited add contract byte-stable.

## Change map (single implementer, sequential)

| # | File | Change |
|---|---|---|
| 1 | `shared/types.ts` | `RepoStatus` is server-local; on `DiffResponse` add `staged: string[]` (paths with index changes vs HEAD, conflicts excluded). New `UnstageRequest = { paths: string[] }`; reuse `AddResult` for the response. |
| 2 | `server/adapters/git.ts` | `RepoStatus.staged: string[]`; in the `1`/`2` record branch push path when `xy[0] !== '.'` (rename destinations included). New `unstagePaths(cwd, paths)` → `git restore --staged -- …`, throw on nonzero (mirrors `addPaths`). |
| 3 | `server/services/management.ts` | `unstagePending(targetId, paths)`: clone of `addPending` — same `locked(targetId, …)`, same malformed-path filter (`-`, `..`, empty), revalidate offenders against fresh `status.staged`, `git.unstagePaths`, `discovery.invalidateRepo(wt.path)`. Also add the missing `invalidateRepo` to `addPending`. `diff()` wip branch: pass `staged: status?.staged ?? []` through `pendingFrom` (branch mode: `staged: []` like the other pending lists). |
| 4 | `server/index.ts` | `POST /api/worktrees/:id/unstage` — `IdParams` + existing `AddBody.safeParse`, → `management.unstagePending`, `mgmtReply` on error. No new error codes. |
| 5 | `src/lib/api.ts` | `unstagePaths(worktreeId, paths) => post<AddResult>(…)` (mutation: no deadline, carries `MUTATION_HEADER` via `post`). |
| 6 | `src/features/worktrees/PendingChanges.tsx` | New props `staged: string[]`, `onRemove(paths)`. Header: "Restore all (N)" when `staged.length > 0`. New row group (after unstaged rows): `✔` icon + `staged` tag + **Restore** button (`aria-label="Restore <p> — unstage, keeps file changes"`). Render condition includes staged. |
| 7 | `src/features/worktrees/DiffView.tsx` | Pass `staged={diff.staged}` + `onRemove={removePending}`; new `removePending(paths)` mirroring `addPending` (busy flag, note `N file(s) restored (unstaged)` / offenders, then `load()`); extend the section-visibility condition with `diff.staged.length > 0`. |
| 8 | Tests | see Verification. |
| 9 | Docs | README pending-changes bullet (Add ↔ Restore + Restore all), canonical plan amendment, AGENTS baseline count. |

Dependencies: 1 → 2 → 3 → 4 → 5 → 6/7 (parallelizable) → 8 → 9.
`pendingKnown` (fail-open) semantics unchanged; `nothing_to_commit` guard
unaffected (unstage never commits).

## Verification

- **Adapter** (`server/adapters/git.test.ts`, real temp repo): staged list
  contains a pure-staged file and an MM file; `unstagePaths` returns a
  previously-added file to `untracked`/`unstaged` and empties `staged`;
  unicode filename survives unstage round-trip (extends the F10 suite).
- **Service** (`server/services/management.commit.test.ts` harness):
  happy-path unstage; offender rejection for a path that is not staged
  (untracked path → `ok:false, offenders`); malformed path filter; add
  now invalidates discovery (assert badge refresh via spy or second
  snapshot).
- **Route** (`server/security.routes.test.ts`): `/unstage` without
  mutation header → 403 `missing_request_header`; empty paths → 400.
- **UI** (`src/features/worktrees/DiffView.test.tsx`): fixture with
  `staged: ['x.ts']` renders Restore row + Restore all; click →
  `api.unstagePaths('wt_1', ['x.ts'])`; note rendered; **switch test**:
  Add click → reload fixture reports the path staged → same path now
  renders Restore (button flipped), Add gone.
- **E2e** (`e2e/commit-untracked.spec.ts`): fixture-mode graceful contract
  — POST `/unstage` on nonexistent fixture paths → 200 `ok:false` with
  offenders (mirror of the existing add test), empty paths → 400.
- **Gate**: `npm run typecheck && npm test && npm run build &&
  npm run test:e2e` + live read-only smoke (no real staging against the
  user's repos without explicit request).

## Out of scope

- Per-hunk changes, conflict resolution, commit-message flow, badge logic.
- Server-side dedupe of repeated unstage requests (idempotent by git
  semantics: restoring an already-unstaged path reports it as offender).
