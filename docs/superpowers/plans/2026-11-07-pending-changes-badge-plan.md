# Pending-Changes Badge on Agent Card — Implementation Plan

Date: 2026-11-07
Status: Implemented (2026-11-07). Verification: 235 vitest (+1 adapter count, +2 jsdom), 26 Playwright (+1 non-fabrication), typecheck + build clean, live smoke: workmux-http agent pendingChanges=8 ahead=1. Canonical amendment: docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md § "Pending-changes badge".

## Goal

Agent cards show a badge (e.g. `●N`) when the agent's worktree has N files
with changes to be committed (untracked + unstaged + staged + conflicts),
mirroring the existing `↑N` unpushed badge pattern. Hidden when N is 0 or
git info is unavailable — never fabricate.

## Design decisions

- **Count semantics**: N = number of distinct file paths with any pending
  change in `git status --porcelain=v2` file entries (each path counted
  once, so `MM` = 1, `??` = 1, `AA` = 1). This is exactly "files to be
  committed" and matches what the pending-changes diff section lists.
- **Data plumbing**: `RepoStatus` gains `pendingChanges: number` (entry
  count from the existing porcelain parse — no new subprocess).
  `GitInfo` gains `pendingChanges: number | null` (null = git
  unavailable), set in `discovery.gitInfoFor` alongside `ahead`/`behind`.
- **Badge visuals**: `●N`, `bg-warn/15 text-warn` pill (consistent with the
  worktree card's `dirty` pill; count adds precision), title
  `"N file(s) pending commit"`, `tabular-nums`, hidden when `null` or 0.
  Position: left of the `↑N` badge in the card header status row.
- **Worktree cards unchanged** (they already show a `dirty` pill).
- **No behavior change** to commit/add flows; badge is display-only.

## Files & ownership (single owner per file)

|File|Change|
|---|---|
|`shared/types.ts`|`GitInfo.pendingChanges: number \| null`|
|`server/adapters/git.ts`|`RepoStatus.pendingChanges` = porcelain file-entry count in `repoStatus` parse|
|`server/services/discovery.ts`|pass `pendingChanges` through `gitInfoFor`|
|`src/features/dashboard/AgentCard.tsx`|badge render next to `↑N`|
|`fixtures/*.json`|not needed (fixture mode ⇒ git null ⇒ no badge; e2e asserts non-fabrication)|
|tests + docs|below|

Dependencies: types → git adapter → discovery → UI (strict order; tests per
layer).

## Verification

1. `server/adapters/git.test.ts` +1: temp repo with `??` + `M ` + `MM` +
   `A ` paths → `pendingChanges === 4` (distinct paths), clean repo → 0.
2. `src/features/dashboard/AgentCard.test.tsx` +2: badge shows `●3` with
   `pendingChanges: 3`; hidden at 0 and with `git: null`.
3. `e2e/push.spec.ts`-style non-fabrication: fixture dashboard has no `●`
   badge (git unavailable in fixture mode) — extend existing badge-absence
   assertion.
4. Gate: `npm run typecheck && npm test && npm run build && npm run test:e2e`.
5. Live read-only smoke: `/api/dashboard` on a fresh server → workmux-http
   agent shows `pendingChanges >= 1` (repo has unstaged edits now); no
   mutations executed.
6. Docs: README feature bullet + count refresh; canonical plan amendment
   (additive); AGENTS.md baseline count.

## Out of scope

- Per-status breakdown tooltips (staged vs unstaged counts).
- Auto-refresh timing changes (badge follows existing 2 s discovery TTL).
- Worktree-card badge restyle.
