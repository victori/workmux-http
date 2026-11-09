# Workmux HTTP Dashboard Implementation Plan

> For agentic workers: Use `superpowers:executing-plans` to implement this plan task by task. Do not implement until the user requests implementation.

**Goal:** Build an iPhone-first native React dashboard that discovers and operates existing workmux sessions, with iPad support as the secondary layout target.

**Architecture:** A Node.js backend on the same Mac reads workmux/tmux metadata, captures existing agent output, sends literal messages and explicit keys, and performs workmux management actions. Responsive React/HTML is the primary interface; xterm.js is supplementary for an optional advanced terminal. A local HTTP port serves the frontend, API, and WebSocket connection from one origin within the user's secure VPN environment.

**Tech stack:** React, TypeScript, Vite, Tailwind CSS, Fastify, WebSockets, node-pty, xterm.js, Vitest, React Testing Library, and Playwright.

**Specification:** This document consolidates the original design and the grill-me interview decisions. Earlier terminal-first interaction, dashboard scope exclusions, application login, and mandatory HTTPS are superseded. This is a planning artifact, not an implementation report.

## Requirements and constraints

- Use a Vite-scaffolded React TypeScript application and Tailwind CSS.
- Recreate the dashboard as native React views rather than embedding the workmux TUI.
- Connect to existing workmux/tmux sessions and their running processes. Never launch replacement agents as part of attachment.
- Optimize touch interaction and software-keyboard behavior for iPhone Safari first; iPad Safari second.
- Show only workmux-managed sessions and their agents; no unmanaged tmux view.
- Keep navigation independent between browser tabs and desktop tmux. Selection in the web UI must not select or resize desktop panes/windows.
- Allow fast session switching, native agent output viewing, a multiline message composer, and explicit special-key controls.
- Allow simultaneous browser and desktop input without exclusive control. Do not restrict sending to agents marked waiting.
- Run as the same OS user as workmux, with access to its tmux socket.
- Initial scope is one host, one configured tmux socket, and one authorized user, with multiple browser tabs supported.
- No implementation-time commits, pushes, or branch creation. Future user-triggered product worktree creation and commit-instruction actions are separate from this restriction on coding-agent work. Back up existing untracked files with timestamped `.bak` files before modifying them.
- Before implementation, inspect applicable AGENTS.md instructions. After meaningful changes, run focused verification and review the diff for regressions.

## Scope

Target functionality parity with the installed workmux TUI dashboard using native touch-friendly React controls: Agents/Worktrees tabs, status, search, all sorts and filters, quick/previous-agent navigation, output previews, agent input, PR links, WIP/review diffs, hunk staging/skipping/splitting/undo, hunk comments, commit instructions, merge, command palette, and context-menu actions.

Include native worktree/agent creation using known projects and their existing workmux configurations, profiles, and layouts. The form takes project, branch/worktree name, optional initial prompt, and optional existing agent profile; otherwise use project defaults. Do not introduce a separate web configuration system.

Confirm merges, worktree removal, and stopping agents with the exact project/target shown. Preserve workmux's dirty-worktree and merge-conflict checks; never silently force an operation. Navigation, messages, and hunk staging remain immediate. The commit action sends the TUI-equivalent instruction to the agent rather than implicitly committing in the backend.

An advanced terminal is optional for full terminal interaction; routine dashboard functionality must not depend on it. Separate workmux configuration editing, unmanaged tmux management, and multi-host orchestration are out of scope. Do not execute commands automatically on attachment.

## Integration facts and verification gate

The workspace was empty when planning began. Locally installed workmux is version 0.1.280 and tmux is installed. The installed workmux README documents:

- `workmux list --all --json`: worktrees with project, project_path, handle, branch, path, is_main, mode, has_uncommitted_changes, is_open, agent_statuses, and created_at.
- `workmux status --all --json`: scoped observations and tracked agents; `--git` adds Git information.
- The TUI has Agents and Worktrees tabs, priority/project/recency/natural sorting, session/name/stale filters, output preview, input mode, and WIP/branch diffs.
- Repositories without tracked agents are not necessarily discoverable through `--all`.

These are documented capabilities, not verified runtime payloads. A workmux help invocation failed because its log file could not be opened under the sandbox. Resolve that execution-environment restriction before claiming live integration works; do not silently substitute mock results.

- [ ] Capture real JSON fixtures and validate exit codes and field shapes before writing adapters.
- [ ] Confirm stable mapping between agent records, repositories, worktrees, and tmux panes, including window and session modes.
- [ ] Verify discovery against an explicitly configured tmux socket and configured repository paths.
- [ ] Inventory all installed TUI actions, including Worktrees context menus and command palette. Inspect version-matched upstream source where documentation is incomplete. Record each native equivalent, target resolution, backend operation, and test; never silently omit an action while claiming parity.
- [ ] Verify non-selecting pane capture, literal message submission, and explicit key delivery in disposable sessions. Native browsing and input must not change desktop selection or dimensions.
- [ ] Verify optional advanced-terminal isolation separately. Grouped sessions share pane state and sizes, so they are only a candidate strategy. If the candidate violates independent navigation, revise it before implementing dependent functionality.

## User experience

### iPhone

Use bottom navigation for Dashboard, Sessions, and Agent, with safe-area padding. Agent is a native interaction view, not an embedded terminal. Use a dark theme, readable text, status labels as well as color, and touch targets of at least 44 by 44 CSS pixels. Avoid hover-only actions.

Dashboard uses compact cards and Agents/Worktrees segmented tabs. Agent cards prioritize name, project, status, and elapsed time. Details expose Git data and title when available; absent metadata is shown as unavailable rather than inferred. Worktree cards show branch, path, dirty/open state, and associated agents.

Default agent sort is waiting, done, working, then stale. Also offer project, recency, and tmux order. Search project/worktree names case-insensitively. Provide selected-session/all-session and hide-stale filters. Put secondary filters and sorting in a bottom sheet. Preserve filter/sort preferences in browser storage.

Tapping a card opens native output and agent interaction. Capture output without attaching, selecting, or resizing a terminal. Render escaped HTML with preserved whitespace, safe text colors, wrapping toggle, and horizontal scrolling. This is terminal output, not a fabricated chat transcript. Replace bounded screen/history snapshots rather than appending repeated redraws as messages. Follow output only when the reader is at the bottom and provide Jump to latest. Preserve selection during refreshes; explain when the target disappears.

The Agent header shows the active managed session and agent. Tapping it opens a searchable switcher with recent sessions first. Provide a Previous button and remember the selected agent per session. Selection/history are tab-local; general filters may persist across tabs. Do not use swipe-to-switch gestures. All-session filtering means all workmux-managed sessions only.

Provide a multiline composer with explicit Send, and a toolbar for Enter, Esc, Tab, Ctrl, arrows, and Ctrl+C. Ctrl is a visible, cancelable one-shot modifier. Send complete messages literally as one application submission and special keys only when explicitly tapped. Preserve per-target drafts in tab memory across navigation/reconnect, but never automatically submit them. Freeze target identity at submission so a rapid switch cannot redirect an in-flight message. Provide native text selection and copy/paste fallbacks that work on HTTP without secure-context Clipboard APIs.

Use dynamic viewport units and Visual Viewport events to keep the composer and controls above the software keyboard. Recalculate layout on keyboard, viewport, and orientation changes without resizing the underlying agent terminal. Keep form text large enough to avoid Safari focus zoom. Offer Advanced terminal separately, with an explicit Fit terminal action disclosing shared-layout effects.

### iPad and hardware keyboards

Use a session rail and detail area in portrait when space permits. Landscape supports a persistent sidebar and simultaneous dashboard list plus selected native agent output or diff. Retain touch controls with hardware keyboards attached.

Outside editable fields and advanced terminal focus, support `/` for search, j/k for row navigation, Enter for opening the selected agent, 1–9 for quick selection, Alt+Left for previous session, and Escape for dismissing details/overlays. Never intercept composer or terminal input with dashboard shortcuts.

### Connection lifecycle

Show loading, empty, disconnected, stale-data, dependency-error, and target-ended states explicitly. Safari suspension is expected: refresh and reconnect on foregrounding or network recovery. Disable sending while disconnected. Never queue or replay input or management actions after a disconnect. Distinguish unknown delivery from failed delivery; do not automatically retry ambiguous submissions.

Persist UI preferences and target identity only, not output or messages. Keep drafts in tab memory. Selecting an ended target offers the switcher rather than opening a substitute. Closing a browser tab or stopping the HTTP service must leave original sessions running, except for explicit confirmed stop/remove operations.

## Backend and interfaces

Organize frontend features under `src/features/`, backend adapters/services under `server/`, and normalized contracts under `shared/`. Separate discovery, input delivery, Git/workmux management, request validation, and optional terminal lifecycle. Validate external JSON at adapter boundaries.

| Interface | Behavior |
| --- | --- |
| `GET /api/health` | Readiness and dependency diagnostics. |
| `GET /api/dashboard` | Managed sessions, agents, worktrees, available actions, observation time, and source errors. |
| `GET /api/projects` | Known projects and existing selectable profiles/defaults. |
| `GET /api/agents/:id/output` | Bounded output from the resolved existing agent pane. |
| `POST /api/agents/:id/messages` | Literal complete message with request identity. |
| `POST /api/agents/:id/keys` | Allowlisted explicit key event. |
| `GET /api/worktrees/:id/diff?mode=wip\|branch` | File changes, bounded diff content, and snapshot identity. |
| `POST /api/worktrees/:id/hunks/:action` | Validated stage/split/undo; skip and navigation stay client-side. |
| `POST /api/worktrees` | Create with known project, name, initial prompt, and existing profile. |
| `POST /api/actions/prepare` and `/execute` | Exact-target management actions and required confirmation. |
| `GET /api/operations/:id` | Progress/result of submitted long-running actions. |
| `WS /api/terminal` | Optional advanced attachment, output, explicit input/resize, and detach. |

Use opaque server-issued worktree identifiers and stable tmux IDs, scoped to the configured server. Resolve paths and targets server-side; do not accept arbitrary command names, executable paths, or repository paths from API requests. Execute commands with argument arrays rather than shell interpolation. Bound subprocess time, output size, terminal message size, and preview/diff size; mark truncation explicitly.

Revalidate managed agent/pane identity before input. Do not redirect a stale target to a replacement process; an agent marked working is not inherently unavailable. Serialize web submissions per pane so browser paste/submit sequences do not interleave. Desktop input remains concurrent, without an exclusive-control guarantee. Deduplicate mutations by request identity during the service lifetime; after restart or an ambiguous connection failure, report unknown delivery rather than promising exactly-once execution or retrying automatically.

Bind destructive confirmations to the exact action and target, then revalidate before execution. Serialize conflicting web worktree/Git actions and detect changes from agents or desktop clients. Do not cancel a running merge/create operation solely because the initiating browser disconnects; expose its operation result.

Read workmux JSON plus structured tmux discovery, not undocumented state files. Allow configured repository paths to supplement tracked-project discovery. Distinguish absent tmux sessions from command failure. Preserve successful cached data with an error/stale marker when a source fails.

Resolve existing project defaults and selectable agent profiles rather than creating new configuration. Enforce managed-only targets at the API boundary, including input and optional terminal endpoints, not just in the visible list.

Poll core data every two seconds while there are visible clients, with no overlapping refresh jobs. Refresh Git metadata every ten seconds or on demand. Share cached snapshots across clients. Pause browser polling while hidden and request a fresh snapshot on return.

For WIP diffs, include staged and unstaged tracked changes against HEAD and list untracked files separately. Handle unborn repositories explicitly. For branch diffs, resolve the workmux-configured base branch when available; otherwise report that a base must be configured rather than assuming `main`. Render binary changes as metadata and diff text as escaped content.

Match TUI staging/splitting/undo behavior using validated diff and index snapshots. Reject stale hunks and reload; never undo unrelated staging performed by another client or the agent. Send hunk comments with file, line, hunk context, and user comment. Do not accept arbitrary client-supplied patch text for management operations.

## Optional advanced terminal ownership and sizing

Native output/input uses non-selecting capture and targeted delivery without PTY attachment. Only the explicit Advanced terminal view may attach a PTY-backed client to the existing target. Never recreate shells or agents.

A dedicated grouped session is a candidate attachment strategy, subject to the verification gate. Closing/disconnecting cleans up owned PTY/client/attachment resources only, never original sessions/windows/panes/processes. Use explicit ownership markers and unique instance identity, not a prefix alone. Exclude attachment resources from discovery and bound their lifetime/count.

Independent browser and desktop navigation is required. Grouped sessions isolate selected-window state but still share pane state and sizing; do not treat grouping as proof of isolation. If necessary, revise the advanced-view strategy after disposable testing rather than weakening the requirement.

Preserve existing dimensions by default. Permit resizing only through an explicit Fit terminal action with its shared-layout effect explained; throttle and validate resize events. Do not modify global tmux sizing policy. Reattach without replaying input.

## VPN access

Run on the same Mac/user as workmux. Default port is 3000 and bind address is `127.0.0.1` for VPN forwarding; direct VPN access requires an explicitly configured VPN interface address. Do not default to `0.0.0.0` or modify VPN settings. Serve frontend/API/WebSocket from one origin.

The VPN/host network is the access boundary. No application password, login screen, or authentication cookie is required. HTTP is supported; HTTPS is optional. Validate configured Host and Origin for API requests and WebSocket upgrades. Require same-origin JSON/custom-header mutations, reject cross-origin requests/permissive CORS, and never mutate through GET. Do not log agent input or output by default. Core iOS behavior must work without secure-context-only features such as Clipboard APIs or service workers.

## Implementation tasks

### Task 1: Establish contracts and scaffold

- [ ] Complete the integration verification gate, installed-version TUI action inventory, and sanitized fixtures.
- [ ] Scaffold with Vite's React TypeScript template and Tailwind's Vite integration.
- [ ] Set up Fastify, shared contracts, and same-origin development proxying.
- [ ] Provide `dev`, `build`, `start`, `typecheck`, `test`, and `test:e2e` scripts. Production serves the Vite build and API together.
- [ ] Add focused adapter tests for valid payloads, failed commands, malformed JSON, empty observations, duplicate names, unmanaged sessions, and stable managed-target identity.
- [ ] Verify type checking and production build.

### Task 2: Discovery and mobile dashboard

- [ ] Implement workmux/tmux adapters, stable identity mapping, explicit repository configuration, and cached snapshots.
- [ ] Implement iPhone native navigation, managed-session/agent browser, all TUI filters/sorts, and tab-local recent selections.
- [ ] Add bounded native output and status/error states; verify preview/selection never resizes or selects desktop panes/windows.
- [ ] Test selection retention, disappearing targets, search, priority order, and failed-refresh stale data.
- [ ] Verify no polling overlap and refresh on visibility restoration.

### Task 3: Native agent interaction and VPN request controls

- [ ] Implement configurable loopback/VPN binding, Host/Origin checks, cross-site mutation protection, and managed-only API target validation without application login.
- [ ] Implement literal-message and explicit-key endpoints with target revalidation, request deduplication, and per-pane web serialization.
- [ ] Build native composer, per-target drafts, key toolbar, HTTP-compatible copy/paste, and unknown-delivery/disconnected states.
- [ ] Test working/waiting agents, multiline/special-character messages, duplicate taps, rapid switching, simultaneous browser/desktop input, dropped connections, and dead/reused targets.
- [ ] Verify native interaction targets the existing agent without new sessions, agent restarts, desktop selection changes, or terminal resizing.

### Task 4: Full dashboard management and diffs

- [ ] Implement native creation using known projects and existing defaults/profiles, including initial prompt and operation progress/results.
- [ ] Implement all verified TUI actions, context menus, palette, PR links, and explicit commit-instruction action.
- [ ] Add WIP/branch diffs, hunk staging/skipping/splitting/undo, hunk comments, file navigation, and bounded large-output handling.
- [ ] Add exact-target confirmation for merge/remove/stop actions, preserving workmux protections without implicit force.
- [ ] Test only in disposable repositories: clean/dirty/unborn state, missing bases, external index edits, stale hunks, conflicts, canceled confirmations, and disconnect during operations.

### Task 5: Optional terminal, iPad, and Safari lifecycle

- [ ] Validate the advanced-terminal strategy preserves independent navigation before implementing xterm.js/PTY attachment and owned-resource cleanup.
- [ ] Add advanced view with existing dimensions by default and explicit Fit terminal action; never modify global tmux options.
- [ ] Implement iPad split views, focus-aware hardware-keyboard controls, native viewport/keyboard handling, and foreground refresh/reconnect.
- [ ] Verify original processes survive browsing, switching, tab closure, network interruption, and HTTP-service restart; no automatic input replay.

### Task 6: End-to-end verification and handoff

- [ ] Run focused unit/component tests, tmux integration checks, Playwright workflows, type checking, and production build.
- [ ] Test real iPhone Safari on HTTP over the intended VPN with the software keyboard open, rotation, background/foreground, copy/paste, scroll, and network changes.
- [ ] Test real iPad Safari in portrait/landscape and with a hardware keyboard. Desktop WebKit emulation supplements but does not replace device checks.
- [ ] Verify Host/Origin rejection, cross-site mutation rejection, managed-only target enforcement, request bounds, and absence of sensitive logging.
- [ ] Compare delivered native actions with the installed TUI inventory and explicitly report any parity gap.
- [ ] Document startup, dependency versions, repository/socket configuration, bind/port/origin configuration, VPN access expectations, existing config reuse, and advanced-terminal limits.
- [ ] Review for lifecycle leaks, unsafe command arguments, cross-target input, stale patches, incorrect destructive-action targets, and original-session cleanup. Fix actionable issues and rerun focused verification.
- [ ] Report any device or live-integration checks that could not be performed with the specific reason. Do not claim those checks passed.

## Acceptance criteria

- Only managed workmux sessions appear, with native equivalents for the installed TUI action inventory and the agreed creation form.
- Native composer/key input reaches the chosen existing agent, including while working, with concurrent desktop/browser use supported.
- Session switching is accessible from the Agent header, with a dedicated previous-target action and tab-local navigation.
- Closing/switching/disconnecting does not kill original sessions; reconnect never automatically replays input or destructive actions and reports uncertain delivery.
- Native navigation/input changes neither desktop selection nor dimensions. The optional advanced strategy preserves independent navigation and discloses explicit resizing effects.
- Creation respects existing profiles/layouts; merge/remove/stop confirmations show exact targets and preserve workmux checks.
- iPhone controls remain usable above the software keyboard, with no hover dependence or obscured primary actions.
- iPad uses additional space while retaining touch usability.
- The same-Mac service operates over the VPN on a configurable local port without application login or mandatory HTTPS; Host/Origin and cross-site mutation checks are verified.
- Source failures and missing targets produce explicit states rather than fabricated empty success.
- Verification and second-pass review are completed, with any environmental limitations recorded.

## Handoff

This file authorizes no implementation, deployment, Git initialization, commits, or pushes. Begin implementation only when the user requests it. Product decisions from the grill-me interview are settled. Remaining technical evidence includes runtime JSON schemas, undocumented TUI actions, safe non-selecting input mechanics, and optional advanced-terminal isolation. Resolve those through version-matched inspection and disposable integration tests; if evidence contradicts an agreed requirement, report the specific conflict and revise the affected strategy first.

## Amendments (post-plan, implementation + review, 2026-11-07)

Criteria added or tightened after the plan was written. Defaults and the
original requirements above remain in force unless noted.

### Exposure (extends "Deployment and VPN"; default unchanged)
- `WORKMUX_HTTP_ALLOW_WILDCARD=1` opts in to `0.0.0.0`/`::` binds. Without
  it, wildcard bind still throws at startup ("Do not default to 0.0.0.0"
  preserved).
- `WORKMUX_ALLOWED_HOSTS=*` (`cfg.allowAnyHost`) accepts any Host header.
  Startup prints a stderr warning; missing `Host` remains rejected.
  Documented DNS-rebinding caveat: with no login, any reachable malicious
  page can rebind and appear same-origin — trusted networks only.

### Security hardening (from second-pass security review)
- Confirm tokens are single-use: consumed synchronously at `execute` entry;
  concurrent executes of one token pass exactly once. Tokens are random;
  internal revalidation (`evaluateAction`) never re-issues a token.
- Same-origin check compares host **and port** (closes WS-upgrade CSRF from
  other local pages).
- Request dedup keyed `paneId\0requestId` with in-flight promise sharing; a
  reused requestId can never suppress delivery to a different pane.
- `SAFE_REV` gates repo-controlled revisions (`.workmux.yaml base_branch`,
  create `baseBranch`) against argv option injection.
- Owned terminal sessions: ownership mark verified at creation (kill + throw
  on failure); mid-attach failure kills the owned session; startup sweeps
  orphaned `wmhttp-adv-*`; buffer deleted on paste failure.
- Operations registry evicts finished operations past 100.
- Hunk comments resolve the agent explicitly (`agentId`) or by sole agent;
  otherwise 409 `ambiguous_agent` / 404; errors map to 404/409, never 500.

### Upstream-evidence deviations (verified against workmux 0.1.280)
- Delivery uses raw tmux (`load-buffer` + `paste-buffer -p -d` + Enter), not
  `workmux send` — upstream refuses waiting agents (exit 3). workmux is used
  for lifecycle only (add/merge/remove/close/open).
- Git facts computed per repository; `workmux status --all --git` aborts the
  whole payload when any workdir is not a git repo. `git: null` means
  unavailable, never clean; a non-repo workdir is not a source failure.
- Null `project` in status payloads falls back to the workdir basename
  (workmux's own rule).

### UI / service completeness
- Stop-agent action surfaced in the agent header (⏹ → exact-target confirm →
  operation poll); review found the server-side action had no UI wiring.
- SPA fallback always registered; `index.html` candidates re-resolved per
  request; 503 "Frontend not built yet" when unbuilt; actionable
  `EADDRINUSE` message; Vite dev proxy follows `WORKMUX_HTTP_PORT`
  (`dev` and `start` both default to :3000).
- iOS text inputs render 16px on phones (`text-base md:text-sm`) to prevent
  focus zoom; 44px minimum tap targets enforced globally.
- Split-piece validation (`pieceMatches`) uses multiset line containment.

### Verification delta
- Vitest baseline is now 104 (adds token single-use/concurrency, pane-scoped
  and concurrent dedup, wildcard bind/any-host, stop-flow UI, null-project
  fallback); Playwright remains 11. Live smokes additionally prove parent
  current-window isolation across WS attach and the bind/allowlist matrix
  (0.0.0.0 refused by default; `*` opens all Hosts with warning).
- Still outstanding from the original acceptance list: physical
  iPhone/iPad Safari checks (headless iPhone 13 viewport only) — all other
  acceptance criteria exercised; see README "Verification" and "Limits".

### Banner semantics fix (2026-11-07, post-screenshot report)
- "Data may be outdated" previously fired whenever `snapshot.stale` was
  true — which includes agents merely idle past `staleAfterSecs`. Idle
  agents are attention badges, not stale data.
- Connection state now derives from source health + polling only
  (`deriveConnection` in `useDashboard.ts`): fetch error or all sources
  dead → offline; some sources failed or polling stalled → stale;
  otherwise online. `ConnectionStateBanner` lost its `stale` prop.
- Verification: +6 unit tests (`deriveConnection`, incl. idle-stale →
  online regression) = 110; e2e fixture-mode spec asserts the banner is
  absent despite frozen fixture timestamps.

### Agent view opens at the tail (2026-11-07, user report)
- Entering an agent view landed at the top of the scrollback. Two layout
  defects made the pane non-scrollable, so the existing follow-bottom
  effect (`scrollTop = scrollHeight`) was a no-op and the body scrolled
  instead: `.dvh` used `min-height:100dvh` (indefinite height, defeating
  `h-full` up the chain) and the output box lacked `min-h-0` (flex child
  grew to content height).
- Fix: `.dvh { height: 100dvh }` and `min-h-0` on the output box; the
  pane now scrolls internally, opens at the tail, and follow-break /
  Jump-to-latest work as specified.
- Verification: fixture `output-%287.txt` extended past pane height;
  e2e asserts the pane itself scrolls (`scrollHeight > clientHeight`)
  and rests within 40px of the bottom after open. 11/11 e2e, 110/110
  unit, typecheck + build clean.

### Live null elapsed_secs tolerance (2026-11-07, live incident)
- `workmux status --all --json` emitted `"elapsed_secs": null` for an agent
  with unknown timing (status `-`); the zod schema required a number, so the
  entire status source died with "unexpected payload shape".
- `elapsed_secs` is now `z.number().nullable()`; discovery maps null to 0
  (unknown timing = not stale-by-elapsed). Other nullish fields were already
  tolerated.
- Verification: new adapter test (`null elapsed_secs` parses) = 111 vitest;
  live proof against workmux 0.1.280 with the offending agent present
  (8 agents parsed, 1 null-elapsed).

### Theme support (2026-11-07, follow-on plan 2026-11-07-theme-support.md)
- Added user-selectable themes: Night (default, unchanged palette), Gruvbox
  (dark hard), Twilight (vim twilight role palette). Client-only; durable
  `wmhttp:theme` pref; applies to all surfaces incl. xterm terminal (per-theme
  ansi16 palette, live switch via `term.options.theme`) and iPhone chrome
  (`meta theme-color`). ⚙ sheet on the dashboard header.
- Mechanism: `src/lib/themes.ts` overrides the 14 Tailwind v4 `@theme` CSS
  vars at runtime on `documentElement` + `data-theme`; utilities verified to
  resolve overridden vars (browser probe: `.bg-surface` → #32302f under
  gruvbox). Palette contract + WCAG audit: worst fg/accent/err contrast
  4.29:1 across all themes.
- Verification: +9 unit (contract/applyTheme/prefs/sheet) = 120 vitest;
  +1 e2e (switch, computed-color, reload persistence) = 12 Playwright;
  typecheck + build clean. Visual screenshot pass captured per theme;
  contrast verified numerically (image inspection unavailable).

### Reader/Terminal modes (2026-11-07, plan `docs/2026-11-07-reader-terminal-modes.md`)
- Agent detail is now one target with two explicit modes (Reader / Terminal)
  owned by the App route (`{view:'agent', mode}`); the old separate
  `{view:'terminal'}` route is removed. Reader stays mounted while Terminal
  is active (drafts, scroll, prefs survive the round-trip) but is
  `hidden`+`inert`; only one transport runs per mode. Mode control:
  `aria-pressed` button group in the agent header. Escape outside xterm
  returns to Reader; Escape inside xterm goes to the PTY (TUI apps need it)
  — the ✕ / "Return to Reader" control is the terminal exit.
- Reader polish: named text-size presets (small/normal/large/huge =
  11/12/14/16 px, durable `wmhttp:textSize`, invalid stored values fall
  back to normal); polling pauses while inactive and late responses are
  dropped (cancelled flag + in-flight overlap guard); transient output
  fetch failures keep the last snapshot with an accessible
  "output unavailable (…) — showing last snapshot" notice, cleared on
  recovery (404/410 target-gone stays distinct); wrap toggle label states
  the TUI-border caveat.
- Terminal viewport: no `fit()` on entry — xterm keeps its default grid
  until the server's `attached` ack resizes it; rotation, keyboard, and
  viewport changes never resize the PTY. A wider-than-phone grid is
  preserved via a horizontal-scroll wrapper (width = cols × canvas-measured
  cell width; no xterm private APIs). Resizing the shared window is an
  explicit "Resize shared terminal…" action behind ConfirmDialog (exact
  target + warnings + ack); `fit` is sent only after confirm, and the size
  label ("cols×rows · server size / resized to fit") updates only on the
  server `resized` ack. Unmount sends `detach` and disposes the pty socket.
- Server geometry fix: `attach` previously spawned the PTY at
  `max(client hint, pane size)` — a large client hint could grow the shared
  window on entry. It now ignores hints and spawns at
  `window_width × (window_height + status rows)` via new
  `Tmux.windowGeometry` (optional on `TmuxLike`), so entry leaves the
  shared window exactly as it was. Supersedes the original plan's
  "Fit to screen" button criterion: default entry is now provably
  no-op for geometry, and fitting is confirm-gated and ack-labelled.
- Verification delta: +32 unit (App routing 7, OutputPane 11, TerminalView
  9, AgentView mode-control +4, geometry integration 1) = 152 vitest;
  tmux integration 7/7 incl. geometry audit (attach with 200×100 hints
  keeps window 120×30 and parent window selection; confirmed fit lands
  150×39; detach kills owned session); +6 e2e (mode default, fixture
  refusal, draft round-trip, text-size persistence, wrap no-overflow,
  mocked-WebSocket attach/confirm/resize via `routeWebSocket`) = 18
  Playwright; typecheck + build clean; live read-only smoke
  (`/api/health`, `/api/dashboard`) against real tmux/workmux 0.1.280.
- Disclosed limitations: an explicit fit lands the window at
  `rows − status` (tmux client accounting; the client viewport equals the
  PTY rows, which is the intended fit); iOS Safari visual-viewport and
  keyboard behaviors are unit/e2e-proven only in Chromium emulation —
  real-device spot-check still recommended.

### Pending changes + configurable commit (2026-11-07, plan `docs/2026-11-07-untracked-commit-plan.md`)
- Diff view (WIP) now lists pending changes: untracked AND unstaged tracked
  files (porcelain v2 parse extended with per-entry paths; also fixed a
  latent XY-offset bug where `hasStaged` was always true) plus conflicts,
  with per-file Add / Add-all → `git add --` after revalidating every path
  against a fresh status (stale → `{ ok:false, offenders:[…] }`; `-`-prefixed
  and `..` paths rejected shape-first).
- Direct commit path (user decision): `WORKMUX_<KIND>_COMMIT_CMD` env vars
  (kind uppercased, non-alphanumerics → `_`), e.g.
  `WORKMUX_OMP_COMMIT_CMD="opencode-commit"`. Configured for the worktree's
  agent kind → CommitBar (message box) replaces the agent-commit button for
  that worktree; unset → agent-commit unchanged. Index model: commit contents
  are exactly what was staged; a configured `-a`/`--all` shows a visible
  warning chip. `$@` substitutes the message as one argv element (appended
  when absent); tokenizer honors quotes; no shell, message never parsed.
  Execution is async via the operations registry (202 + poll), timeout
  `WORKMUX_COMMIT_TIMEOUT_MS` (default 120 s); output tail capped 4 KiB.
  Command source is server env only — never request bodies or repo files.
- New API: `POST /api/worktrees/:id/add`, `POST /api/worktrees/:id/commit`
  (202 `{operationId}`); `DiffResponse` gains `unstaged`, `conflicts`,
  `hasStaged`, `commitCmd` (resolved display command; UI picks commit path
  from it). Management gained a cfg dependency (constructor change).
- Verification delta: +30 unit (commitCmd tokenizer 8, real-git adapter 8,
  management add/commit against real git + fake-script 8, DiffView jsdom 6)
  = 182 vitest; +4 e2e (contract validation, malformed/offender rejection,
  empty-message 400, CommitBar graceful failure on missing fixture cwd;
  e2e server exports WORKMUX_CLAUDE_COMMIT_CMD=/usr/bin/true) = 22
  Playwright; typecheck + build clean. Live read-only smoke on a real repo:
  unstaged listed, `commitCmd` resolved, `--bogus` rejected as offender —
  no add/commit executed against real repos. Disclosed: real
  `opencode-commit`/`claude-commit` binaries not invoked in CI; argv
  contract proven by fake-script harness.
- Follow-up (user): `WORKMUX_OPENCODE_COMMIT_CMD` accepted for the opencode
  agent — OMP↔OPENCODE kind aliases (exact-kind variable preferred); +6
  config tests = 188 vitest.
- Follow-up 2 (user live use): `-a` warning chip removed (intentional in
  operator command); CommitBar gained spinner + inline failure alert;
  documented PATH/executable requirement (no shell — zsh functions can't
  resolve; operator handles command resolution themselves). DiffView tests
  adjusted (-a test dropped, spinner test added) = 188 vitest, 22 e2e;
  live stub-commit proof: POST commit → done, output echoed argv.
- Follow-up 3 (user): commit message made optional end-to-end (empty =
  command runs without message arg; `$@` token dropped). +2 tests =
  190 vitest, 22 e2e; live proof POST {} → done.
- Follow-up 4 (user): default `WORKMUX_COMMIT_TIMEOUT_MS` raised
  120000 → 300000 (opencode-commit model runs exceed 2 min); supersedes
  the "default 120 s" figure in the entry above.
- Follow-up 5 (user symptom + convention): `$@` → `{{COMMIT_MSG}}`
  whole-token placeholder (clean cutover; wrapper recipe
  `zsh -ic '… "$@"' _ {{COMMIT_MSG}}`). exec.run rewritten execFile→
  spawn(detached)+kill(-pid) group kill — execFile drops `detached` and
  timeouts orphaned grandchildren (silent late commits). 193 vitest,
  typecheck+build clean; live proof: 3 s timeout kills zsh+sleep tree at
  3006 ms, exit 124, no survivors.
- Follow-up 6 (user symptom): exec.run now always closes child stdin
  (EOF). Previously stdin stayed open when no input was given, so
  stdin-reading CLIs (`opencode run`) blocked forever — the "no OMLX
  activity / command never invoked" symptom. +5 exec.test.ts = 198
  vitest; live proofs: direct `opencode run` exit 0 @23.5 s; server
  cat-probe done @60 ms.
- Follow-up 7 (user ergonomics): {{COMMIT_MSG}} now also substitutes as a
  SUBSTRING inside shell-wrapper commands, context-escaped (dq: backslash
  ` \ " $ ` `; sq: split-and-requote; bare: single-quote wrap); non-shell
  commands raw substring; whole-token unchanged. run.sh recipe simplifies
  to `zsh -ic 'opencode-commit -a "{{COMMIT_MSG}}"'`. +6 tests = 204
  vitest; live injection proof inert (payload with `"; touch …; echo "`
  arrived byte-identical, no side effects).

### Push button + unpushed indicator (2026-11-07, plan `docs/2026-11-07-push-button-plan.md`)
- Agent cards badge `↑N` (unpushed = ahead of upstream; hidden when 0/null,
  never fabricated) + Push button; worktree cards badge only.
- Review-before-approve: `PreparedAction.commits` (sha+subject, cap 20,
  `commitsTruncated`) rendered in ConfirmDialog; token key extended with
  HEAD sha + commit count + ref ⇒ drift after prepare ⇒ ConfirmationError.
- `ActionType` +'push' (routes unchanged; zod enum extended). Evaluation:
  unborn/detached/unsafe-branch/no-origin/zero-ahead ⇒ blocked; first push
  ⇒ warning (creates origin/<branch>, runs `push -u origin <branch>`);
  behind>0 ⇒ warning (remote rejects; NO force path exists, ever).
  Execution async via operations (`WORKMUX_PUSH_TIMEOUT_MS`, default 120s).
- `GitInfo` gains `ahead`/`behind` (null = no upstream; porcelain
  `branch.ab` presence), `WorktreeView.unpushed`, `RepoStatus.hasUpstream`
  + `oid`.
- Verification delta: +4 git adapter (bare remote: first-push -u, ahead/
  range, cap+truncation, non-ff rejected), +7 management integration
  (review list, first push, nothing-to-push block, drift rejection,
  re-confirm push, divergence ack flow, no-origin block), +6 AgentCard
  jsdom (badge show/hide/no-git, dialog lists commits, execute+poll
  success, inline failure) = 222 vitest; +3 e2e (no fabricated badges in
  fixture mode, blocked contract, unknown target 404) = 25 Playwright.
  Live read-only: real fleet ahead counts + 3-commit review list; no push
  executed against real remotes. Disclosed: badge reflects last local
  status (fetches move remote refs); no selective push.
- Follow-up (same day): push dialog commit rows are tappable — full commit
  body (capped 2000 chars, `CommitEntry.body`, `%x09%b%x1e` log format)
  expands inline with aria-expanded; bodyless commits stay static. Ack
  checkbox wording is now per-action via `ackLabel` (push: "I confirm these
  commits are ready to push"; destructive dialogs keep the generic text).
  +1 git test (multi-line bodies), +1 jsdom (expand + wording) = 224.
- Follow-up 2 (same day): push UX fixes from live feedback —
  (1) ack checkbox now renders whenever an ack is required (was gated on
  warnings.length > 0, so clean-tree push showed no checkbox; a
  requireAck-without-warnings dialog was also un-confirmable), and push
  always requires the ack even with zero warnings;
  (2) non-blocking: dialog closes on accept, card shows pulsing
  "pushing…" indicator + final inline ✓/error note (was: dialog frozen
  "Working…" until completion; null-poll left zero feedback);
  (3) +1 e2e execute-token-rejection = 26. Full HTTP push proven
  end-to-end against a disposable bare remote (prepare review list →
  execute 202 → op done "[new branch] main -> main" → badge clears,
  remote sha == local HEAD); real remotes untouched.
- Follow-up 3 (same day): configurable push runner —
  `WORKMUX_<KIND>_PUSH_CMD` (same kind normalization + OMP↔OPENCODE
  aliasing as the commit vars) replaces the built-in `git push` for that
  worktree's agent kind; unresolved/ambiguous/no-agents ⇒ built-in path.
  New `buildPushArgv` in commitCmd.ts: `{{BRANCH}}`/`{{REMOTE}}` whole-token
  = one argv element, substring = context-aware shell escaping (identical
  semantics to `{{COMMIT_MSG}}`), no `{{BRANCH}}` ⇒ branch appended last;
  wrapper owns flags (`-u`), first-push warning reworded when a custom
  command is configured. `git.runPush` adapter mirrors `runCommit`;
  timeout = `WORKMUX_PUSH_TIMEOUT_MS`. +5 argv unit, +3 config,
  +1 management integration (wrapper script logs argv + pushes a new
  branch to the local bare remote) = 233 vitest.

### Pending-changes badge (2026-11-07, plan `docs/2026-11-07-pending-changes-badge-plan.md`)
- Agent cards show `●N` (N files pending commit = distinct porcelain v2
  file entries: untracked + staged + unstaged + conflicts; `MM` counts
  once), warn-colored pill left of `↑N`; hidden at 0/null, never fabricated.
  `RepoStatus.pendingChanges` (count from existing parse, no new subprocess)
  → `GitInfo.pendingChanges` → card. Display-only.
- Verification delta: +1 adapter (mixed statuses → 3, clean → 0), +2 jsdom
  (shows ●3, hidden at 0/no-git), +1 e2e assertion (fixture mode renders
  no ● badge) = 235 vitest / 26 Playwright. Live smoke: real fleet
  workmux-http agent pendingChanges=8, ahead=1.
- Follow-up 4 (same day): root-caused live "push failed" on iPhone over
  LAN — crypto.randomUUID is secure-context-gated; the dashboard runs over
  plain http on a LAN address, so Safari left it undefined and execute
  threw client-side before any request (commit/add were unaffected — they
  send no requestId). New `newRequestId()` in lib/api.ts (randomUUID when
  available, time+random fallback) used at all 8 mutation call sites;
  AgentCard now surfaces the underlying error message instead of the bare
  "push failed". +3 api unit tests = 238 vitest. Test mocks of lib/api
  now spread the real module so util exports survive vi.mock.

### Terminal-mode header + stale fixes (2026-11-08)
- Header vanished in Terminal mode: AgentViewPanel root carried
  hidden/inert={!active}, hiding the mode toggle, Diff, and Stop with the
  reader. Root now always renders; only the reader body (OutputPane +
  Composer) is hidden/inert when mode !== 'reader'; TerminalView is passed
  into the panel via a new `terminal` slot prop (App no longer stacks it as
  a sibling — fixes the collapsed/duplicated h-full layout too).
- "Data may be outdated" during Terminal: dashboard polls stalled while the
  pty attach contended with discovery subprocesses (observed /api/dashboard
  pending >10 s live) tripping the stale threshold. Dashboard polling is
  now paused while Terminal mode is active (the pane is live over WS);
  resume forces refresh(true) and resets lastOkAt so no stale flash.
- Tests: rewrote the old whole-panel-hidden contract test → header-visible
  + reader-body-hidden + slot assertions; +2 useDashboard pause hook tests
  (interval skipped, forced resume refresh, no stale flash) = 240 vitest.
  Live proof: toggle visible at +14.5 s in terminal, zero stale banner,
  clean return to reader.

### No-cache headers for the SPA document (2026-11-08)
- Root cause of "Safari has old bundle": index.html was served with
  `public, max-age=0` + etag; Safari sometimes skips revalidation.
- An onSend hook stamps every text/html response (/, SPA fallback,
  late-built direct read) with `no-store, no-cache, must-revalidate` +
  Pragma/Expires — also keeps Safari out of bfcache for the document.
  Hashed assets now serve `public, max-age=31536000, immutable`
  (content-addressed, safe forever).
- +3 contract tests (document no-store, fallback no-store, asset
  immutable) = 243 vitest; headers verified live via curl.

### Commit-now disabled when clean (2026-11-08)
- CommitBar takes `hasChanges`; the button (and submit path) disable with a
  "Nothing to commit" tooltip unless the diff reports staged, unstaged,
  untracked, or conflicted files.
- DiffResponse gains `pendingKnown` (false when git status could not be
  read): the UI fails OPEN when status is unknown — a degraded status read
  must not lock out committing; the server is the arbiter there.
- Server defense for stale views: commitWorktree rejects
  `nothing_to_commit` when a readable repo status shows zero pending
  changes (unborn repos exempt).
- +4 tests (disabled-when-clean, staged-only, degraded fail-open, server
  reject) = 247 vitest; live diff carries pendingKnown.

### Audit remediation round 1 — F01 F06 F08 F12 (2026-11-08, audit `docs/2026-11-08-project-audit.md`)
- F01 (P1, reproduced): percent-encoded paths (`/%61pi/...`) routed into API
  handlers while the preHandler guard tested the raw `req.url`, skipping
  Host/Origin/mutation-header validation. Guard now classifies via
  `req.routeOptions.url` (router-resolved pattern) with the raw prefix kept
  as a secondary signal. Live proof: encoded mutation 403
  `missing_request_header`, encoded GET + forbidden Host 403
  `forbidden_host`; canonical flows unaffected.
- F08 (P2): confirm tokens were only TTL-pruned on later prepares; execute
  now rejects tokens older than `BOUNDS.confirmTokenTtlMs` (still consumed
  synchronously before the expiry check).
- F12 (P3): uncaught ZodErrors (e.g. `?force=wrong`) escaped as 500; a
  global error handler maps them to 400 `invalid_request` with bounded
  detail, and unexpected errors to a detail-free 500 `internal_error`.
- F06 (P1): the gate was red — DiffView Add-all test had no `addPaths`
  resolution, so the handler threw an uncaught TypeError (exit 1 despite 247
  green). beforeEach now resolves it and the test asserts the `2 files
  staged` notice. `npm test` exits 0 again.
- +7 tests (5 route-security, 1 validation contract, 1 token TTL) = 254
  vitest, exit 0; build clean; 26 e2e.
- Open from the audit (not this round): F02 (shell-substring interpolation —
  migration-affecting), F03 (lock spans execution), F04 (terminal attach
  lifecycle), F05 (pane-scope product decision), F07 (dependency upgrades),
  F09 (fit measures expanded grid), F10 (porcelain -z), F11 (fetch deadlines).

### Audit remediation round 2 — F02 F03 F04 F05 F07 F09 F10 F11 (2026-11-08)
- F02 (P1, policy: harden escaping, keep substring): placeholder
  substitution now uses a left-to-right quote-context scanner with POSIX
  backslash rules (`\"` inside `"…"` no longer closes the region; nothing
  escapes inside `'…'`), and the tokenizer keeps escaped quotes inside
  double-quoted config tokens. Proven by real-shell round-trip tests:
  `$(id)`/backticks after an escaped quote stay literal bytes.
- F03 (P1): worktree locks span OPERATION COMPLETION (Operations.settled),
  not just start; execute re-evaluates confirmation state INSIDE the lock;
  commit, add, and hunk actions share the same per-target lock. Two clients
  can no longer interleave destructive commands or index mutations.
- F04 (P1): attach reserves capacity synchronously (pending counts toward
  maxOwnedTerminals), carries a per-socket generation, and is cancelled by
  close/detach/reattach — cancelled attaches kill their owned session and
  PTY instead of leaking; onExit only removes its own registration;
  killOwnedSession rejections handled everywhere.
- F05 (P1, policy: full-session access, disclosed honestly): `attached`
  carries `activePaneId` (tmux list-panes on the owned session) and a 2 s
  watchdog emits `pane-changed`; the UI shows a warning banner whenever the
  window's active pane is not the requested agent ("keystrokes go there").
  No shared-window selection changes are introduced.
- F07 (P1): @fastify/static 8→10.1.10, vitest 3→5.1.0; `npm audit` now
  reports ZERO vulnerabilities (prod+dev). node-pty native verified intact.
- F09 (P2): fit proposals measure the VISIBLE viewport (clientWidth/Height
  of the scroll wrapper), never the expanded inner grid; no local
  `fit.fit()` — the grid changes only on the server `resized` ack.
- F10 (P2): `git status --porcelain=v2 -z` — NUL-delimited records, raw
  paths (unicode/quotes/backslashes/tabs/newlines round-trip status→add),
  rename source records consumed, destination counted once.
- F11 (P2): GET reads carry `AbortSignal.timeout(15000)`; mutations
  deliberately keep no deadline (aborting a possibly-applied mutation would
  fabricate an unknown-delivery the server never reported).
- +18 tests = 272 vitest exit 0; build clean; 26 e2e; typecheck 0.

### Restore staged (unstage) for added files (2026-11-08)
- Pending-changes section now lists STAGED paths too (`DiffResponse.staged`,
  `RepoStatus.staged` from porcelain v2 `xy[0] !== '.'`, conflicts excluded).
  A file's button flips Add ↔ Restore as its staged state changes; bulk
  *Restore all (N)* mirrors *Add all*. Restore = `git restore --staged --`
  (worktree content never touched).
- New sibling endpoint `POST /api/worktrees/:id/unstage` reusing AddBody +
  AddResult (audited `/add` contract unchanged; no new error codes).
  `unstagePending` mirrors `addPending`: same per-target lock, revalidates
  paths are still staged (offenders otherwise), conflicts never restorable.
- Bonus fix: `addPending` now calls `discovery.invalidateRepo()` (hunkAction
  already did) — pending badges refresh immediately after staging instead of
  waiting out the 2 s TTL; `unstagePending` invalidates too.
- Deviation from the planning doc: no `UnstageRequest` shared type added —
  the existing `AddRequest` is unused dead code; a mirror would add weight.
- Verification delta: +15 vitest (287 total: adapter staged-list + unstage
  round-trip incl. unicode/added-then-edited, service happy/offenders/
  malformed/unknown-target, route header+400+404, jsdom Restore row/Restore
  all/Add→Restore flip/offender note) +1 e2e (unstage validation contract,
  27 total); typecheck and build clean.

### Living spec + drift harness (2026-11-08)
- Added `docs/SPEC.md`: current-state specification (system model, security
  gates, endpoint/env/error tables, invariants, state machines, WS protocol,
  UI capability inventory, doc map). The plans + this amendment trail remain
  the immutable decision log; SPEC.md absorbs current truth so correctness
  no longer requires reading amendments in order.
- Precedence rule codified (SPEC.md + AGENTS.md): code + green tests >
  SPEC.md > latest amendment > AGENTS conventions > README > dated plans.
- `server/docs.spec.test.ts` machine-checks the enumerable tables against
  `server/index.ts` / `config.ts` / `security.ts` — adding a route, env var,
  or error code without a spec update fails `npm test`. Harness proven by
  live mutation (removed env row -> failure -> restore -> green).
- Also fixes latent README drift (e2e count 26 -> 27). Verification delta:
  +11 vitest = 298 exit 0; typecheck clean.

### Kind-less pane filtering (2026-11-08, user report)
- workmux registers every pane in a project window as an agent record; a zsh
  pane running ./run.sh surfaced as a second "agent" for the same worktree
  (agent_kind null, status done). Discovery now drops records with no
  `agent_kind` when building the snapshot — they leave the agent list AND
  `agentTargets()` (consistent: invisible panes are not message targets).
  Tradeoff, accepted deliberately: panes running an agent CLI that workmux
  cannot classify are hidden too; upstream kind detection is the source.
- +2 discovery tests (null/undefined kind excluded; targets exclude them).

### Commit history browser (2026-11-08, plan docs/2026-11-08-commit-log-plan.md)
- Agent view gains a **Commits** button -> new route/view listing the
  worktree's `git log` (newest first, default 50, cap `BOUNDS.maxCommits`
  200); clicking a commit opens the existing DiffView in new
  `mode=commit`, showing that commit's diff vs FIRST PARENT (root commits
  fall back to empty-tree diff via `git show --format=`); commit mode is
  read-only — no mode toggle, pending section, or footer actions; back
  returns to the list.
- New `GET /api/worktrees/:id/commits`; `/diff` extended with
  `mode=commit&sha=` — sha gated by SAFE_REV + `..` rejection (400);
  `DiffResponse.commit` carries metadata. Broken/nonexistent repo paths
  degrade to an empty list (spawn-error catch), never a fabricated error.
- The drift harness caught the new route mid-implementation (SPEC table
  update required to pass) — first real-world proof of the harness.
- Verification delta: +24 vitest (324 total: 7 adapter incl. unicode
  subjects/merge/root-commit/unsafe-rev, 4 service, 3 route, 5 CommitsView,
  3 DiffView commit-mode, 2 AgentView button) +1 e2e (28 total: graceful
  degradation + sha validation); typecheck + build clean; live smoke on a
  spare port against the real repo (list + parent-1 diff of a real commit).

### Unpushed badge without configured upstream (2026-11-09, user report)
- Branches pushed WITHOUT `-u` (e.g. `git push origin main-test`) have no
  tracking config, so porcelain emits no `# branch.ab` and the dashboard
  showed no unpushed badge despite commits sitting ahead of origin.
- `repoStatus` now falls back to `origin/<branch>` when no upstream is set
  and that remote-tracking ref exists (same rule `unpushedCommits` already
  used for push review — badge and push dialog now agree): ahead/behind via
  `rev-list --left-right --count`, flagged `upstreamAssumed`. Discovery
  maps counts through when assumed; branches with neither upstream nor
  origin ref (true first push) stay badge-less as before.
- Live proof: dc-archtics-api/main-test (no upstream, origin ref 2 behind)
  went from `ahead: null` to `ahead: 2`. +2 adapter tests (326 total);
  typecheck + build + 28 e2e clean.
