# Repository Guidelines

## Project Overview

**workmux-http** is an iPhone-first web dashboard that discovers and operates
existing [workmux](https://github.com)/tmux coding-agent sessions over VPN
HTTP. It renders agents, worktrees, diffs, and confirmations as native mobile
views (no TUI embedding), with no app login — the network boundary is the
security boundary. Backend: Node + Fastify 5 driving `tmux`/`workmux`/`git`
binaries. Frontend: React 19 + Tailwind v4 SPA.

## Architecture & Data Flow

```
HTTP/WS → preHandler checkRequest (host allowlist, port-exact origin,
          x-workmux-request header) → zod validation → services →
          revalidate against latest Discovery.snapshot() → adapters →
          exec.run(argv) → tmux / workmux / git binaries
```

- `server/index.ts` — `buildApp(cfg)` wires all deps (constructor injection,
  `AppDeps`); all routes, WS `/api/terminal`, SPA fallback, `isMain` startup.
- `server/services/` — `discovery` (2 s TTL cache, in-flight dedupe,
  last-good + per-source `stale` markers), `input` (pane-scoped requestId
  dedup, per-pane queue, revalidate-before-send), `management`
  (prepare/execute single-use confirm tokens, hunk stage/split with
  `snapshotId` staleness, worktree create/merge/remove), `operations`
  (disconnect-safe registry), `terminal` (owned grouped sessions
  `wmhttp-adv-*` marked `@wmhttp_owned`, node-pty attach).
- `server/adapters/` — `tmux` (structural `TmuxLike` interface; services
  depend on the interface, tests fake it), `workmux` (zod-validated JSON,
  `DependencyError`), `git` (porcelain v2 status, diffs, `applyToIndex`,
  `resolveBase` via `.workmux.yaml` → origin/HEAD).
- `server/exec.ts` — the **sole** subprocess gateway: `execFile` argv-only,
  no shell ever, bounded timeout/output. All new subprocess calls go here.
- `shared/types.ts` — single source of API contracts; change it first for
  any API shape change; server imports it with `.js` suffix, `src/` via
  `@shared/types`.

Error → HTTP codes: 400 `invalid_request` · 403 `forbidden_host`/
`cross_origin`/`missing_request_header` · 404 `target_not_managed`/
`target_not_found` · 409 `confirmation_required`/`snapshot_stale`/
`sweep_busy`/`ambiguous_agent` · 410 `target_gone` · 502 `delivery_unknown`/
`dependency_error` · 202 for create/execute/sweep scan+execute.

## Key Directories

| Path | Purpose |
| --- | --- |
| `server/` | Fastify backend (`index`, `config`, `security`, `exec`, `targets`, `hunks`) |
| `server/adapters/` | `tmux.ts` `workmux.ts` `git.ts` `github.ts` `sweep-git.ts` process boundaries |
| `server/services/` | `discovery` `input` `management` `operations` `terminal` `github-status` `target-locks` `sweep-policy` `sweep` |
| `shared/types.ts` | API contracts shared by backend and frontend |
| `src/` | React SPA: `App.tsx` (router/state), `features/{dashboard,agent,worktrees,terminal,palette}`, `components/`, `hooks/`, `lib/{api,storage}.ts` |
| `fixtures/` | Fixture-mode payloads (`list-all.json`, `status-all.json`, `output-<paneId>.txt`) — tracked; e2e depends on them |
| `e2e/` `integration/` | Playwright specs; real-tmux integration |
| `test/setup.ts` | jsdom Web Storage shim + jest-dom |

## Development Commands

```sh
npm install
npx node-gyp rebuild --directory node_modules/node-pty  # native pty build
npm run build      # vite → dist/public + tsc → dist/server
npm start          # node dist/server/index.js → http://127.0.0.1:3000
npm run dev        # tsx watch server :3000 + vite :5173 (open 5173!)
npm run typecheck  # app + server tsconfigs
npm test           # vitest run (node + dom projects)
npm run test:e2e   # playwright (builds + fixture server :4173)
npx vitest run server/services/input.test.ts   # single file
```

`dev` and `start` both bind :3000 — stop one first or use
`WORKMUX_HTTP_PORT=3001` (the Vite proxy follows it). Key env:
`WORKMUX_HTTP_BIND` (wildcard `0.0.0.0`/`::` refused unless
`WORKMUX_HTTP_ALLOW_WILDCARD=1`; host allowlist stays enforced either way),
`WORKMUX_ALLOWED_HOSTS`,
`WORKMUX_TMUX_SOCKET`, `WORKMUX_REPOS`, `WORKMUX_HTTP_FIXTURES` (fixture
mode; advanced terminal refuses there). `WORKMUX_ALLOWED_HOSTS=*`
(`cfg.allowAnyHost`) accepts any Host — DNS-rebinding exposed; never make
it the default in code or docs.

## Code Conventions & Common Patterns

**Server**
- ESM + NodeNext: relative imports need `.js` suffix (`../adapters/tmux.js`).
  `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (`import type`).
- Validate every request body/param with top-level zod schemas in
  `index.ts` (zod v4: `z.int()`, `.catch()`); bounds from `BOUNDS`
  (config.ts), never magic numbers.
- **Invariants to preserve:** managed-only targets (revalidate ids against
  `discovery.agentTargets()`/`worktreeTargets()` at mutation time);
  single-use confirm tokens consumed synchronously and re-evaluated at
  execute; never select/resize shared tmux windows during capture/input/
  attach (navigation uses owned sessions; explicit confirmed Terminal
  resize affects all clients; `killOwnedSession` double-checks
  `@wmhttp_owned`); never auto-retry
  ambiguous delivery (`UnknownDeliveryError` → 502 `delivery_unknown`);
  degrade with `stale` markers, never fabricate empty data; gate
  repo-controlled revisions with `SAFE_REV`; push names one explicit remote
  (`git push [-u] <remote> <branch>`, never bare/force) resolved
  request→upstream→origin→sole, bound into the token with the `-u` decision
  and re-checked against `git remote` at prepare AND execute (`SAFE_REMOTE`
  rejects `ext::` helpers).
- Adapters expose structural interfaces (`TmuxLike`) so unit tests inject
  fakes — keep them current when adding tmux calls.
- Ids: opaque `wt_<sha1[:12]>` worktrees, tmux `%N` pane ids; mint via
  `server/targets.ts`.

**Frontend**
- Hooks only — no redux/router libs. Routing is a `Route` discriminated
  union in `App.tsx` (`useState`), not the URL.
- Named function component exports + exported `interface XProps` (App is the
  only default export). Feature folders own their components.
- Every mutation call carries `requestId: newRequestId()` (`src/lib/api.ts`
  — `crypto.randomUUID` when available, timestamp+random fallback otherwise;
  `randomUUID` is secure-context-gated and undefined over LAN-IP http).
- Destructive UI flow: `api.prepare` → `ConfirmDialog` (exact `targetLabel`
  + warnings ack) → `api.execute` (token) → poll `api.operation` at 1 s.
- State persistence: `loadPref/savePref` (localStorage, `wmhttp:` prefix,
  durable prefs) vs `loadTab/saveTab` (sessionStorage, `wmhttp-tab:`,
  per-tab: `agentId`, `recents`, `sessionFilter`, `draft:<agentId>`);
  lazy init `useState(() => loadPref(...))`, persist inside the setter.
- Poll loops: module `const POLL_MS = 2000`, gate on
  `document.visibilityState === 'visible'`, `cancelled` flag in effects,
  refs mirroring latest state for stable keydown listeners.
- Errors: `err instanceof ApiError ? err.message : String(err)`; notices
  via `role="status" aria-live="polite"`.
- Styling: Tailwind v4 `@theme` tokens in `src/index.css` — colors
  `bg surface surface-2 line fg fg-muted accent ok warn err working
  waiting done stale` with `/opacity` modifiers; utilities `.safe-top
  .safe-bottom .dvh .pulse-dot .terminal-output`. Mobile rules: 44px min
  tap targets (global CSS), text inputs `text-base md:text-sm` (iOS zoom
  guard), `max-h-[85dvh]` sheets, `md:` breakpoint = iPad layout.
- Pane ids in URLs: `encodeURIComponent` (`%286` → `%25286` on the wire).
- Layout: app root `.dvh` is `height:100dvh` (definite — `h-full` chains
  depend on it). Any flex-column child that must scroll internally needs
  `min-h-0` + `overflow-auto`; without `min-h-0` it grows to content and
  the body scrolls instead (breaks follow-bottom/scroll logic silently).
- Theming: NEVER hardcode colors in components — use the token utilities
  (`bg-surface`, `text-fg-muted`, …). Palettes live ONLY in
  `src/lib/themes.ts` (14 CSS-var tokens + per-theme xterm palette); a new
  theme = one `Theme` entry + `THEME_IDS` + contract tests. Runtime switch =
  `applyTheme` overrides the CSS vars; xterm follows via `term.options.theme`.
- Data freshness = `deriveConnection(snapshot, error, lastOkAt)` (source
  health + polling) — NEVER `snapshot.stale` (that includes idle agents;
  those render as per-agent Stale badges only).

## Important Files

- `server/index.ts` — routes, security hooks, WS, SPA fallback, html
  no-cache headers (onSend hook), startup
- `shared/types.ts` — API contracts (edit first for API changes)
- `server/config.ts` — env parsing + `BOUNDS` limits
- `server/security.ts` — host/origin/header gates (no login by design)
- `server/exec.ts` — argv-only subprocess gateway
- `src/App.tsx` — route union, keyboard shortcuts (Alt+←, Esc, `:`, ⌘P,
  `/`, j/k, 1-9), bottom nav + iPad sidebar
- `src/lib/api.ts` — typed API client, `MUTATION_HEADER`, `encodeId`
- `vite.config.ts` / `vitest.config.ts` / `playwright.config.ts` — toolchain
- `README.md` — user-facing startup, env table, VPN model, TUI parity
- `docs/README.md` — documentation index, lifecycle, and historical records
- `docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md` —
  historical scaffold design/plan + amendments through the documentation transition

## Specification deltas

Before implementing a behavior change, state a concise delta:

- Before: the existing behavior or requirement.
- After: the intended behavior, including relevant failure cases.
- Reason: why this change is needed.
- Invariants: which safety guarantees must remain true.
- Verification: the observable evidence that will establish the change.

Proceed when the delta is within the user's requested scope. Ask for
clarification only when it contradicts an explicit requirement or requires
a material decision outside that scope.

Update documentation in the same change:

- `docs/SPEC.md` for current behavior, contracts, and state machines.
- The relevant feature design/plan for decisions, deviations, and verification;
  `docs/decisions/` for lasting decisions spanning features.
- `README.md` when setup or user-visible behavior changes.
- `AGENTS.md` only when development conventions change.

For bug fixes, preserve the intended requirement and correct the code.
Never weaken a requirement or test merely to make verification pass.

For important bug fixes, demonstrate that the regression test fails before
the fix and passes afterward. Report any verification limitations.

Before finishing, compare the final implementation with the stated delta
and review the diff for undocumented behavior changes.

## Invariant-to-test mapping

- `docs/SPEC.md` maps each core invariant's stable `INV-*` ID to named
  regression tests and coverage limits. Use these IDs in the specification
  delta, verification report, and review findings; never renumber or reuse IDs.
- Before editing, inspect the mapped tests for affected invariants and
  identify what they actually assert. Run the referenced test files for
  focused verification, then the full verification gate.
- Update the mapping in the same change when an invariant or mapped test
  changes. If the task needs evidence the mapped tests do not provide, add
  a focused regression or report the specific verification limitation.
  Record unrelated coverage gaps without claiming they are resolved.
- `server/docs.spec.test.ts` checks complete mappings and declared test
  references. Reference existence does not establish behavior; skipped
  native/tmux checks are not live integration proof.

## Spec Maintenance (post-plan changes)

- `docs/SPEC.md` is the **current-state specification** (what the system
  does today). Any change to routes, env vars, error codes, invariants,
  WS protocol, or state machines MUST update it in the same commit.
  `server/docs.spec.test.ts` machine-checks route/env/error tables and
  invariant-to-test mappings — drift fails `npm test`.
- Precedence on conflict: code and tests establish observed behavior.
  User-approved requirements establish intended behavior. A conflict is a
  finding to resolve, not permission to rewrite the requirement.
  For conflicting current-behavior documents: SPEC.md takes precedence;
  approved proposals describe intended changes, not implemented behavior.
  AGENTS.md governs development conventions; README.md covers usage.
  Historical plans/amendments explain past decisions. A later decision
  supersedes an earlier one only when it explicitly links and says so.
  None of these documents overrides explicit user requirements.
- Record what changed, why, and dated verification evidence/limits in the
  relevant feature design/plan in the same change. For small fixes without
  a plan, use a dated amendment in the related feature document; create a
  short feature record if none exists. Use `docs/decisions/` for lasting
  decisions spanning features, not a duplicate record for every change.
- The initial dashboard plan and its old amendments remain historical.
  The 2026-11-10 documentation transition ends the requirement to append
  every future change there. Follow the relevant feature's decision trail.
- NEVER rewrite original criteria to match implementation. Add dated
  deviations or superseding decisions with links; preserve historical evidence.
- Changes to user-visible behavior or env vars also update
  `README.md`; convention-level facts update this file.
- Backup rule applies to any file not tracked by version control: create a
  timestamped `.bak` of the original before editing. Check tracking status
  rather than assuming plan docs are untracked.

## Documentation organization and lifecycle

- `docs/README.md` indexes designs, plans, decisions, and audits. Update it
  when adding, moving, superseding, or closing a document.
- Save all new designs to
  `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and all new plans to
  `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, regardless of which agent
  or skill writes them. Never place dated plans directly in `docs/`.
  Keep existing filenames stable within those directories.
- Save audits to `docs/audits/YYYY-MM-DD-<topic>.md`; save significant
  lasting decisions to `docs/decisions/YYYY-MM-DD-<topic>.md`.
  Screenshots stay in `docs/screenshots/`.
- New designs/plans include Date, Status, related design/plan links,
  affected SPEC sections and INV-* IDs (or “none” with a reason), and
  Verification (pending until evidence exists). Status is one of `draft`,
  `approved`, `in-progress`, `implemented`, `superseded`, or `abandoned`.
  Record approval only when actually given; partial delivery stays
  `in-progress` with completed and remaining scope stated explicitly.
- Before implementation, designs describe proposed behavior, failure cases,
  and acceptance criteria; plans link the design and define tasks/tests.
  Small fixes may keep design and plan in one short record. Do not split
  legacy combined documents or invent missing historical approvals.
- During implementation, update current-state SPEC alongside code/tests.
  At completion, reconcile design/plan status and the index, record dated
  verification and deviations, and link current SPEC. Do not mechanically
  check historical task boxes without evidence for each task.
- Preserve completed records in place. Superseding documents link both
  directions; do not move completed plans into another archive directory.
- Use relative Markdown links for navigation and repair inbound references
  when moving files. Repository-relative code paths may remain in backticks.
- Superpowers is opt-in. These locations apply whether it is used or not;
  its templates do not override repository instructions, including no
  automatic commits or pushes.

## Runtime/Tooling Preferences

- Node **≥ 22** (ES2024 server target; `Promise.withResolvers`); repo runs
  Node 26. ESM (`"type": "module"`). npm (lockfileVersion 3); no Bun/Yarn.
- TypeScript 5.9, two projects: app (ES2023, bundler resolution,
  `@shared/*` alias) and server (ES2024, NodeNext). No root tsconfig.
- `node-pty` requires script approval (`allowScripts` pinned in
  package.json) + native build; advanced terminal fails without it.
- External deps at runtime: `tmux`, `workmux` on PATH, `git`; `gh` optional
  (PR links). Never assume `workmux status --all --git` — upstream aborts
  on non-git workdirs; use per-repo `git.ts`.
- Delivery uses raw tmux (`load-buffer`/`paste-buffer -p -d` + Enter), not
  `workmux send` (upstream refuses waiting agents).

## Testing & QA

- **Vitest 5** with projects: `node` (server/shared/integration) and `dom`
  (jsdom, `src/**/*.test.tsx`, setup `test/setup.ts` — Web Storage shim).
  501 tests green baseline.
- Conventions: server/integration/e2e use `test('should…')`; client
  `src/` tests use third-person `it('renders …')` without "should".
  Colocated `*.test.(ts|tsx)`; component tests add
  `// @vitest-environment jsdom` pragma (present on most) +
  `afterEach(cleanup)` (no `globals: true`); mock
  `vi.mock('../../lib/api')` with full `api` object + `ApiError` class;
  harnesses: `fakeWorkmux` (single-body shell script),
  `fakeTmuxWithLog` (call log + `gate` promise for concurrency), real-git
  temp repos (`commit.gpgsign false`), real-tmux on disposable sockets —
  `wmhttp-itest` (tmux) and `wmhttp-sweep-it` (sweep; separate sockets,
  parallel spec files must never share one) (`describe.skipIf` when tmux
  absent).
- **Playwright** e2e: iPhone 13 viewport (chromium), fixture-mode server on
  :4173 (`WORKMUX_HTTP_FIXTURES=$PWD/fixtures`); fixture pane ids are
  double-encoded in spec URLs (`%25287`).
- Verification gate before declaring done: `npm run typecheck && npm test
  && npm run build && npm run test:e2e`, plus a live read-only smoke
  (`/api/health`, `/api/dashboard`) when touching server paths — never send
  messages to real agents during tests.
