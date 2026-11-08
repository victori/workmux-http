# Pending Changes + Configurable Commit

Date: 2026-11-07
Status: Implemented (2026-11-07). Verification: 182 vitest (commitCmd
builder 8, real-git adapter 8 incl. status-parse + runCommit timeout,
management add/commit 8, DiffView jsdom 6), 22 Playwright e2e (4 new),
typecheck + build clean, live read-only smoke on a real repo (unstaged
listed, commitCmd resolved, `--bogus` offender rejected). Canonical
amendment: `docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md`
§ "Pending changes + configurable commit". Disclosed: real
opencode-commit/claude-commit not invoked in CI (fake-script harness
proves argv); conflict resolution UI out of scope.

## Goal

In the worktree diff view:

1. Show the **pending changes** from `git status` — untracked files *and*
   unstaged tracked files — with buttons to stage them for commit (per file
   + add-all).
2. Provide a commit button with a message input. When a commit shell command
   is configured for the worktree's agent kind, the button runs that command
   with the message; otherwise the existing agent-commit behavior (send
   literal `commit` to the owning agent) stays exactly as today.

## Decision record (user, 2026-11-07)

- **Config source**: per-agent-kind env vars —
  `WORKMUX_OMP_COMMIT_CMD="opencode-commit"`,
  `WORKMUX_CLAUDE_COMMIT_CMD="claude-commit"`. General rule:
  `WORKMUX_<KIND>_COMMIT_CMD` where KIND = `agentKind` uppercased,
  non-alphanumerics → `_` (agentKind is a free-form string from workmux
  `agent_kind`). `OMP` and `OPENCODE` are interchangeable spellings of the
  same agent (workmux reports opencode as `omp`); the exact-kind variable
  wins over the alias.
- **Fallback**: command defined → shell commit is *the* commit path for that
  worktree; not defined → keep the existing agent-commit button unchanged.
- **Execution**: async via the existing operations registry
  (`Operations.start` → 202 + `GET /api/operations/:id`), because
  `opencode-commit` calls an LLM and can take tens of seconds.
- **Index model** (supersedes the initial `-a` sketch): the commit contains
  **exactly what the index holds** — hunks staged via the existing Stage
  buttons plus files added via the new Add buttons. Recommended commands
  therefore carry **no `-a`** (`git commit -m "$@"`, `opencode-commit`).
  `-a` still works if configured, but the UI warns that it commits all
  tracked changes regardless of staging.

## Message templating

`$@` in the configured command is replaced by the message as **one argv
element**. If no `$@` token is present, the message is appended as the last
element. The command string is tokenized on whitespace honoring single/double
quotes; there is no shell, no expansion, no eval (exec.ts invariant).

| Config | Effective argv |
| --- | --- |
| `opencode-commit` | `opencode-commit <message>` |
| `git commit -m $@` | `git commit -m <message>` |
| `my-commit --sign -- "$@"` | `my-commit --sign -- <message>` |
| `opencode-commit -a` (discouraged) | `opencode-commit -a <message>` + UI warning |

## API contract (edit `shared/types.ts` first)

- `GET /api/worktrees/:id/status` → `WorktreeStatus {
  branch, ahead, behind, hasStaged, hasUnstaged,
  untracked: string[], unstaged: string[], conflicts: string[],
  initialized: boolean, commitCmd: string | null }`
  - `unstaged` = tracked files with worktree-side changes not fully staged
    (porcelain XY position 2 ≠ `.`; `MM` files appear in both lists is
    fine — Add re-stages the whole file).
  - `conflicts` = unmerged paths (`u ` entries); surfaced so the UI can
    warn before commit attempts.
  - `commitCmd` = the resolved display command for this worktree's agent
    kind (null when not configured) so the UI can pick the commit path
    without duplicating env logic.
- `POST /api/worktrees/:id/add` body `{ paths: string[] }` (1..200 paths)
  → revalidates every path against a **fresh** `untracked ∪ unstaged ∪
  conflicts` set; any path missing now → 409 `snapshot_stale` (response
  lists offenders). Otherwise `git add -- <paths>` → returns fresh
  `WorktreeStatus`. (`git add` covers untracked and unstaged identically.)
- `POST /api/worktrees/:id/commit` body `{ message: string }`
  (1..4096 bytes) → resolves owning agent kind → env command; none
  configured → 400 `commit_cmd_not_configured`; otherwise
  `operations.start('commit', label, …)` → **202** `{ operationId }`.
- `GET /api/operations/:id` (existing) → on completion the result carries
  `{ ok, outputTail, status: WorktreeStatus }`.

Error mapping (existing codes): 400 invalid_request /
`commit_cmd_not_configured` · 404 target_not_found · 409 snapshot_stale /
ambiguous_agent · 202 for commit.

## Server changes

- `server/config.ts`
  - `commitCmdFor(kind: string | null): string | null` (env lookup +
    normalization).
  - `BOUNDS`: `maxCommitMessageBytes = 4096`, `maxAddPaths = 200`.
  - `WORKMUX_COMMIT_TIMEOUT_MS` (default 120000) passed to the commit exec.
- `server/commitCmd.ts` (new): tokenizer + `$@` substitution → `string[]`;
  rejects empty argv; unit-tested standalone (no fs, pure function).
- `server/adapters/git.ts`
  - `repoStatus`: extend parse to collect `unstaged` (XY pos-2) and
    `conflicts` (`u ` entries) alongside existing `untracked`.
  - `addPaths(cwd, paths)` → `git add -- <paths>` via `run`.
  - `runCommit(cwd, argv, timeoutMs)` → `{ code, stdout, stderr }` via
    `run` with the commit timeout override.
- `server/services/management.ts`
  - `addPending(worktreeId, paths)`: managed-only revalidation against
    `discovery.worktreeTargets()`, fresh `repoStatus` staleness check
    (union set), defense-in-depth path shape rejection (`-` prefix, `..`
    segments), `git add`, return fresh status.
  - `commitWorktree(worktreeId, message)`: managed-only revalidation;
    owning-agent resolution reuses the sole-agent rule (one agent → its
    kind; several agents of the same kind → that kind; mixed kinds →
    409 `ambiguous_agent`); env lookup; `operations.start('commit', …)`;
    the operation body runs `runCommit` and returns
    `{ ok: code === 0, outputTail, status }` (fresh status even on
    failure).
- `server/index.ts`: three routes, top-level zod schemas (zod v4, bounds
  from `BOUNDS`), status codes per contract.

## Frontend changes

- `src/lib/api.ts`: `worktreeStatus(id)`, `addPaths(id, paths)`,
  `commit(id, message)`; every mutation carries `requestId` where the
  endpoint accepts one (commit posts `{ message, requestId }` — server
  ignores requestId but keeps the client convention).
- `src/features/worktrees/DiffView.tsx` (+ two new feature components):
  - `PendingChanges.tsx`: section listing untracked + unstaged paths
    (grouped, untracked marked 🆕) with per-file **Add** and **Add all**;
    conflicts listed with a warning and excluded from Add-all; hidden when
    empty or repo uninitialized; refreshes from the returned status;
    409 stale → notice + refresh.
  - `CommitBar.tsx`: shown when `status.commitCmd` is non-null —
    message textarea (placeholder shows the resolved command, e.g.
    `opencode-commit "$@"`), **Commit now** button, busy state while
    polling `/api/operations/:id` at 1 s (visibility-gated, cancelled on
    unmount), result notice with output tail, then status + dashboard
    refresh. Inline warning chip when the configured command contains
    `-a`/`--all` ("commits all tracked changes, ignoring hunk staging").
    When `commitCmd` is null the existing footer agent-commit renders
    unchanged.

## Security invariants (must hold)

- argv-only execution; the message is never parsed by a shell and is a
  single argv element; `$@` substitution happens at argv level.
- Commit command comes **only** from server env config — never from request
  bodies, never from repo-controlled files (`.workmux.yaml` stays out).
- Add paths must exist in a fresh `untracked ∪ unstaged ∪ conflicts` list at
  mutation time (client-supplied lists are not trusted) plus shape
  rejection.
- Managed-only target revalidation at mutation time (existing invariant).
- Commit output tail capped (e.g. 4 KiB) before it enters the operations
  registry / response.

## Out of scope

Discard/clean of files; push; amend; signing options; per-request custom
commands; commit from the dashboard (diff view only); conflict resolution UI.

## Tests & verification

1. `server/commitCmd.test.ts` — tokenizer, quotes, `$@` middle/end/absent,
   empty-argv rejection.
2. `server/adapters/git.test.ts` (real-git temp repo, existing harness) —
   status parse yields correct `untracked`/`unstaged`/`conflicts` (incl.
   `MM` in both lists); `addPaths` stages exactly the listed files
   (untracked + unstaged); `runCommit` against a fake commit script asserts
   argv + timeout honored.
3. `server/services/management` additions — unmanaged 404; stale path 409
   with offender list; ambiguous kinds 409; not-configured 400; happy
   commit completes as operation with `outputTail` + fresh status.
4. `src/features/worktrees` jsdom tests — pending list renders both groups
   + Add calls api and refreshes; Add-all excludes conflicts; CommitBar
   presence keyed on `commitCmd`; `-a` warning chip; busy → poll →
   success/failure notices; existing agent-commit button untouched when
   `commitCmd` null.
5. e2e (fixture mode): `/api/worktrees/:id/status` degrades gracefully
   (paths don't exist on this host) — assert the notice, no crash. Full
   behavior is proven by 1–4.
6. Gate: `npm run typecheck && npm test && npm run build && npm run
   test:e2e` + read-only live smoke (`/api/health`, `/api/dashboard`).
   Disclose: real `opencode-commit` not invoked in CI (binary presence
   host-dependent); argv contract proven by fake-script harness.

## File ownership / dependency order

| # | Files | Depends on |
| --- | --- | --- |
| 1 | `shared/types.ts` (contracts) | — |
| 2 | `server/config.ts`, `server/commitCmd.ts` + test | 1 |
| 3 | `server/adapters/git.ts` + test | 1 |
| 4 | `server/services/management.ts`, `server/index.ts` + tests | 1–3 |
| 5 | `src/lib/api.ts`, `DiffView.tsx`, `PendingChanges.tsx`, `CommitBar.tsx` + tests | 1 |
| 6 | e2e spec, README, canonical spec amendment, this plan's status flip | 1–5 |

## Docs (repo rule)

README env table (`WORKMUX_<KIND>_COMMIT_CMD`, `WORKMUX_COMMIT_TIMEOUT_MS`)
+ feature bullets (index-model semantics, `-a` warning); additive amendment
in `docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md`; status
flip here with verification delta. Timestamped `.bak`s before editing
untracked files; no commits.

## Post-implementation overrides (user, 2026-11-07 live use)
- `-a` warning chip REMOVED: `-a` is intentional in the operator's command
  ("commit all" is the desired commit portion), so the warning was noise.
  Index-model wording stays: commit contents = what the index holds.
- CommitBar UX: spinner (animate-spin, aria-busy) while the operation runs;
  failures surfaced INLINE under the bar (`role="alert"`, "commit failed:
  <error>") instead of the top notice banner; request-level errors
  (400/404/config) also inline.
- Shell resolution: commands run via execFile argv — NO shell, no rc-file
  sourcing. `opencode-commit`/`claude-commit` were zsh functions in
  ~/.zshrc → ENOENT (the silent "button does nothing"). Command resolution
  (script on PATH or other) is handled by the operator; the dashboard only
  requires an executable + exported env for the command.
- zsh-function access (operator choice): wrap the command in interactive
  zsh — `WORKMUX_OMP_COMMIT_CMD="zsh -ic 'opencode-commit -a \"\$@\"' _"`
  — `-i` loads ~/.zshrc, `_` is $0, message appended as $@ (one argv
  element, never re-parsed by the outer tokenizer since $@ sits inside a
  quoted token). Live proof: probe command via real server → done,
  `opencode-commit: function` + message echoed.
- Commit message is OPTIONAL (user): empty/whitespace/omitted submits;
  buildCommitArgv drops a standalone `$@`/`"$@"` token and appends nothing;
  zod `.optional()` (no min(1)); client no longer silently no-ops on empty.
  Live proof: POST {} → done, stub saw `ARGS: 1 | -a`.
