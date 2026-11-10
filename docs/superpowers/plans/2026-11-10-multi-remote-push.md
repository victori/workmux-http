# Multi-remote push support — plan (2026-11-10)

Status: APPROVED FOR IMPLEMENTATION (scope decisions confirmed with owner
2026-11-10). Do not commit; leave changes for human review.

## Goal

The push action is origin-centric: first push hardcodes
`git push -u origin <branch>` (`server/adapters/git.ts:455`), the custom
command placeholder `{{REMOTE}}` is substituted with literal `'origin'`
(`server/services/management.ts:504`), and the unpushed badge tracks one
ref (upstream, else `origin/<branch>`). Repos with a second remote (e.g.
`origin` = gitea, `github` = GitHub) cannot target it from the dashboard
and get no signal when the secondary remote is behind.

Add: a remote picker in the push confirm flow (choice bound into the
confirm token), per-remote unpushed badges on cards, and smart `-u`
semantics.

## Approved decisions

1. **Scope**: selector + per-remote badges. No push-all action.
2. **Upstream rule (smart `-u`)**: `-u` only when the branch has no
   upstream at all, OR the user ticks "set `<remote>` as upstream"
   (checkbox offered whenever the selected remote differs from the
   current upstream remote; default unticked when an upstream exists,
   ticked on first push).
3. **Custom cmds**: `WORKMUX_<KIND>_PUSH_CMD` receives the picked remote
   through `{{REMOTE}}`; a cmd containing no `{{REMOTE}}` token owns the
   remote itself → picker is locked (shown read-only, "configured command
   decides") and the resolved remote is not forced.

## Remote resolution chain (server-side default)

`request.remote` → upstream remote (remote component of `@{u}`) →
`origin` → sole configured remote → none (blocked: `no remote
configured`, replacing today's `hasOrigin` gate). The picker preselects
this default.

## API contract (`shared/types.ts` — change FIRST)

```ts
export interface RemoteStatus {
  name: string
  url: string
  /** True when refs/remotes/<name>/<branch> exists locally. */
  hasRef: boolean
  /** Commits on HEAD not on <name>/<branch>; null when hasRef is false
   *  (never pushed there) or git state unknown. */
  unpushed: number | null
  /** True when this remote is the branch's upstream remote. */
  upstream: boolean
}
```

- `WorktreeView.remotes?: RemoteStatus[]` — absent = git source unhealthy
  (never fabricate). Origin stays first, then alphabetical; cap 8
  (`BOUNDS.maxRemotesPerRepo = 8`).
- `PrepareActionRequest` + `PreparedAction`: optional `remote?: string`
  (pick) and on the response `remote?: string` (resolved) plus
  `remoteLocked?: boolean` (custom cmd without `{{REMOTE}}`).
- `setUpstream?: boolean` on prepare + execute requests and
  `PreparedAction` (echo of the effective value).
- Zod (`server/index.ts`): `remote: z.string().max(64).regex(SAFE_REMOTE).optional()`,
  `setUpstream: z.boolean().optional()`. `SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/`
  exported from `server/adapters/git.ts` — no colons ⇒ `ext::`-style
  helper names die at the schema; membership in `git remote` output is
  re-checked at prepare AND execute (defense in depth, INV-08 family).

## Token binding (invariant)

`evaluateAction('push')`: `keyExtra` gains `[resolvedRemote,
String(setUpstreamEffective)]`. Consequences, each a test:
- switch remote between prepare and execute → token mismatch →
  409 `confirmation_required` (client must re-prepare);
- remote deleted between prepare and execute → 409 `snapshot_stale`;
- execute re-resolves and re-validates membership; it never pushes a
  remote the token didn't bind.

## Server design

### `server/adapters/git.ts`
- `remoteNames(cwd)` — parse `git remote -v` (name + fetch url).
- `remoteStatuses(cwd, branch, cap)` — one `git remote -v` + one
  `git for-each-ref refs/remotes --format='%(refname)'` + one
  `git rev-list --count <name>/<branch>..HEAD` per remote whose ref
  exists (local refs only, no network). Upstream remote marked by
  comparing `@{u}`'s remote component.
- Replace `push(cwd, branch, setUpstream, …)` with
  `pushTo(cwd, remote, branch, setUpstream, …)`:
  `git push [-u] <remote> <branch>` — always explicit remote (kills
  push.default ambiguity). Keep `SAFE_REV` on branch, add `SAFE_REMOTE`
  + membership check at the adapter boundary too.
- `unpushedCommits` unchanged (upstream/origin semantics stay — the
  commits list in the dialog is about what HEAD carries, per-remote
  deltas come from `remoteStatuses`).
- `hasOrigin` deleted; callers use `remoteNames`.

### `server/services/discovery.ts`
- Attach `remotes` per worktree from `remoteStatuses` inside the same
  per-worktree git fan-out; unhealthy git ⇒ field absent (existing
  degrade path).

### `server/services/management.ts`
- `evaluateAction('push')`: resolve remote via chain; blocked reasons
  updated (`no remote configured`, per-remote `nothing to push` only
  when the *selected* remote is up to date); warnings name the resolved
  remote (`creates github/feat/x and sets upstream`,
  `github has N newer commit(s)…` computed from
  `rev-list --count <remote>/<branch>..HEAD` vs
  `HEAD..<remote>/<branch>` behind-count when hasRef).
- `runAction('push')`: revalidate target + remote membership; custom cmd
  → `buildPushArgv(cmd, { branch, remote: resolved })`; no `{{REMOTE}}`
  in cmd → locked picker, cmd runs as-is; else `git.pushTo(...)`.
- `pushCmdForWorktree` unchanged; expose `remoteLocked` when cmd lacks
  `{{REMOTE}}`.

### `server/commitCmd.ts`
- No substitution change needed (already parameterized); add test proving
  a non-origin remote value flows through whole-token and substring
  forms.

## Frontend design

- `src/components/ConfirmDialog.tsx`: optional push-remote section —
  radio list of `RemoteStatus` (name, `↑N` or `new branch`, `upstream`
  tag), the set-upstream checkbox, and a locked-state line. New props:
  `remotes?: RemoteStatus[]`, `remote?: string`, `setUpstream?: boolean`,
  `remoteLocked?: boolean`, `onRemoteChange?(name)`,
  `onSetUpstreamChange?(v)`. Callers without push don't pass them;
  behavior unchanged.
- The five `ConfirmDialog` call sites that do push (`AgentView`,
  `AgentCard`, `WorktreeCard`, `TerminalView`, `DiffView`): on remote or
  checkbox change → re-`api.prepare` with the new pick, swap token +
  warnings + commits atomically (mirror the SweepSheet
  keep-branches-invalidate pattern).
- `WorktreeCard` / `AgentCard`: replace single `●N` unpushed pill with
  per-remote pills (`origin ↑2`, `github ↑5`, muted `github new`); keep
  the existing aggregate pill when `remotes` absent (stale git).
- Push entry points default `remote` to the server-resolved default (no
  client-side chain logic — the server echo in `PreparedAction.remote`
  is authoritative for the dialog's preselection).

## Task breakdown (file ownership; build/lint/test only in Task 8)

| # | Task | Owns | Depends |
|---|---|---|---|
| 1 | Contract: types + zod schemas + `SAFE_REMOTE` + `BOUNDS.maxRemotesPerRepo` | `shared/types.ts`, `server/index.ts`, `server/config.ts`, `server/adapters/git.ts` (const only) | — |
| 2 | Git adapter: `remoteNames`, `remoteStatuses`, `pushTo`, membership; unit tests on temp repo with two bare remotes | `server/adapters/git.ts`, `git.test.ts` | 1 |
| 3 | Discovery: attach `remotes`, degrade rules; discovery tests | `server/services/discovery.ts`, `discovery.test.ts` | 1, 2 |
| 4 | Management: resolution chain, token binding, warnings, custom-cmd lock, `pushTo`; `management.push.test.ts` | `server/services/management.ts`, `management.push.test.ts`, `server/commitCmd.test.ts` | 1, 2 |
| 5 | UI: ConfirmDialog section + 5 call-site re-prepare wiring + card badges | `src/components/ConfirmDialog.tsx`, the 5 feature files + their tests | 1, 4 |
| 6 | e2e: fixtures gain `remotes`; badge + picker + re-prepare-on-switch + intercepted execute payload asserts | `fixtures/*.json`, `e2e/` | 3, 5 |
| 7 | Integration: real-git dual-remote push incl. `-u` semantics | `integration/` | 2, 4 |
| 8 | Docs + gate: SPEC (action semantics, INV-08 row extension, no new routes/env), README, AGENTS.md invariant bullet, plan amendments trail; full gate | `docs/SPEC.md`, `README.md`, `AGENTS.md`, canonical plan | 1–7 |

## Verification matrix

- Unit: default chain (upstream-remote / origin / sole / none-blocked);
  token binds remote + setUpstream (switch → 409); deleted remote at
  execute → 409; `SAFE_REMOTE` rejects `ext::sh -c evil`, `--mirror`,
  empty; `remoteStatuses` counts vs two bare remotes incl. never-pushed
  (`hasRef:false, unpushed:null`); `pushTo` lands commits on the chosen
  bare remote, `-u` only per rule; custom cmd `{{REMOTE}}` = picked,
  cmd without token → locked + untouched argv.
- Component: picker renders/preselects, switching re-prepares and swaps
  token, locked state hides radios, badges render per remote with
  fallback pill.
- e2e (fixture mode, intercepted): badges visible; push opens dialog
  with both remotes; switching remote issues a second prepare and the
  executed payload carries the new remote + token.
- Integration (real git, temp bare remotes): first push `-u` to github
  sets upstream; later push to origin without tick leaves upstream on
  github.
- Gate: `npm run typecheck && npm test && npm run build && npm run
  test:e2e` + docs.spec green; live read-only smoke untouched
  (`/api/dashboard` shows `remotes`); no pushes to real remotes during
  verification.

## Estimated test delta

~+14 vitest (git ~5, management ~5, discovery 1, commitCmd 1, dialog 2)
→ ~491; e2e +1 → 44.

## Risks / notes

- Per-worktree subprocess cost grows with remotes (≈2 + ≤8 local-only
  calls per worktree per refresh); cap 8 and skip rev-list when ref
  missing keeps it bounded; watch discovery latency in the 2 s poll.
- `unpushed` (legacy field) stays upstream-centric for compatibility of
  existing consumers; `remotes` is additive-optional — no breaking
  change to `shared/types.ts` consumers.
- GitHub remote URLs may be ssh vs https; badges/picker treat remotes
  opaquely (no URL parsing) — GitHub-specific logic stays in
  `github.ts`'s resolver.
- Token key change invalidates in-flight prepared pushes across upgrade —
  acceptable (clients re-prepare on 409 by existing contract).
