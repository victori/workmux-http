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
below against `server/index.ts`, `server/config.ts`, and `server/security.ts`
in the normal `npm test` run. Adding a route/env var/error code without
updating this file fails the suite.

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
| `GET /api/operations/:id` | operation registry view |
| `WS /api/terminal` | advanced terminal (owned sessions only) |

Conventions: ids are opaque (`wt_<sha1[:12]>`, tmux `%N` — URL-encoded on
the wire); every mutation body carries a client `requestId` (dedupe for
messages; pane-scoped). Reads use a 15 s client deadline; mutations
deliberately have none (aborting a possibly-applied mutation would fabricate
unknown delivery). Create/execute/commit return **202** with `operationId`;
poll `GET /api/operations/:id`.

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
| `snapshot_stale` | 409 | diff `snapshotId` superseded (hunk ops) |
| `target_gone` | 410 | target vanished mid-operation |
| `delivery_unknown` | 502 | message delivery ambiguous — never auto-retried |
| `dependency_error` | 502 | tmux/workmux/git binary failed |
| `internal` | 500 | route-level unexpected |
| `internal_error` | 500 | global error handler fallback (detail-free) |

Per-path rejections (add/unstage/commit) return **200** with
`{ ok: false, message, offenders }` — a validated request whose paths went
stale is not an HTTP error.

## 4. Core invariants

1. **Managed-only targets**: mutations revalidate ids against
   `discovery.agentTargets()` / `worktreeTargets()` at execution time.
2. **Single-use confirm tokens**: consumed synchronously at execute and
   re-evaluated (TTL + state key) inside the lock; execute never trusts
   prepare-time state.
3. **Per-target locks span operation completion** (`Operations.settled`),
   serializing commit/add/unstage/hunk/merge/remove/stop/push per worktree.
4. **Never select/resize shared tmux windows** — only owned grouped
   sessions `wmhttp-adv-*` marked `@wmhttp_owned`; `killOwnedSession`
   double-checks the marker.
5. **Never auto-retry ambiguous delivery** (`UnknownDeliveryError` →
   `delivery_unknown` 502).
6. **Degrade, never fabricate**: source failure ⇒ last-good + `stale`
   markers; empty data only when genuinely empty.
7. **Conflicts are awareness-only**: `u` paths listed, never auto-added,
   never restorable via unstage.
8. **Repo-controlled revisions gated by `SAFE_REV`** before any diff/
   merge of attacker-influenced refs.
9. **Stale writes blocked**: hunk ops carry `snapshotId`; superseded ⇒
   `snapshot_stale`.
10. **Data freshness** for the banner = `deriveConnection(snapshot, error,
    lastOkAt)` (source health + polling), **never** `snapshot.stale` alone
    (idle agents are per-agent badges, not a connection problem).
11. **Terminal is session-wide and honestly disclosed**: attach targets the
    requested pane but tmux focus is per-window; `attached.activePaneId` +
    2 s watchdog emit `pane-changed` and the UI names the keystroke target.

## 5. State machines

**Confirm token**: `prepare(action,target)` → `{token, targetLabel,
warnings, stateKey}` → user ack → `execute(token)` — consumed once;
expired TTL ⇒ `confirmation_required`; state key changed since prepare ⇒
re-confirm.

**Operations registry**: `running` → `done | failed`; `settled(id)` resolves
at completion (locks release then); settled ops pruned past retention.

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

- **Dashboard**: agents/worktrees tabs, search/sort/filters, per-agent
  pending badge (`●N`), unpushed indicator, connection banner, PR links.
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
they drift every feature). This file's tables are checked by
`server/docs.spec.test.ts`.

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
the same commit; the drift harness enforces the enumerable subsets.
