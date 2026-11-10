# Explicit Reader / Terminal Modes

Date: 2026-11-07
Status: Implemented (2026-11-07). Verification: 152 vitest (incl. 7 App
mode-routing, 11 OutputPane, 9 TerminalView, 1 real-tmux geometry audit),
18 Playwright e2e (6 new reader/terminal specs incl. mocked-WebSocket
transport), typecheck + build clean, live read-only smoke against real
tmux/workmux 0.1.280. Canonical amendment:
`docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md` §
"Reader/Terminal modes". Disclosed: iOS Safari real-device pass still
recommended; explicit fit lands the window at rows−status (tmux client
accounting; client viewport equals PTY rows).
Post-ship fixes (2026-11-08, canonical § "Terminal-mode header + stale
fixes"): the panel header (mode toggle, Diff, Stop) is now always visible —
the whole-panel hidden/inert was replaced by hiding only the reader body, and
TerminalView renders into a `terminal` slot inside the panel; dashboard
polling pauses while Terminal is active (attach stalls /api/dashboard), with
a forced refresh on resume.

## Goal

Make reading an agent on an iPhone comfortable without changing its desktop
terminal layout. Expose two clearly named modes for the same managed agent:
Reader for responsive reading and message composition; Terminal for faithful,
interactive terminal access. This is not a PTY-to-chat conversion project.

## Current implementation

- `src/features/agent/AgentView.tsx` already combines a polling `OutputPane`
  with a `Composer`; a separate button opens the advanced terminal route.
- `src/features/agent/OutputPane.tsx` replaces full ANSI-styled screen snapshots
  every two seconds. It supports wrapping, follow-bottom, and Jump to latest.
  Unchanged snapshots skip DOM replacement, preserving text selection.
- `src/index.css` uses `pre-wrap` and `overflow-wrap: anywhere` for output.
  Browser wrapping cannot remove hard line breaks already captured from tmux.
- `src/features/terminal/TerminalView.tsx` uses xterm.js over WebSocket. The
  server reports authoritative dimensions; Fit to screen explicitly resizes
  the PTY. There is no ongoing viewport-resize observer.
- `server/services/terminal.ts` attaches an owned grouped tmux session to the
  existing shared windows. It starts the PTY at the maximum of requested and
  pane dimensions. Independent session selection does not imply independent
  window geometry; resizing can affect other clients, subject to tmux policy.
- `src/App.tsx` stores agent and terminal as separate routes. A terminal route
  carries an agent ID, but its label currently uses the globally selected
  agent. Unifying the modes must resolve identity from one consistent target.
- Fixture mode deliberately refuses advanced terminal attachment. The current
  iPhone Playwright project runs Chromium, not actual iOS Safari.

## Product decisions

### Mode selection and navigation

1. Add an always-visible, accessible Reader / Terminal segmented control to
   the agent detail header. Use buttons with `aria-pressed` and a labeled
   group; do not introduce tab semantics without full tab keyboard behavior.
2. Opening an agent from Dashboard, Sessions, recents, or the palette defaults
   to Reader on every screen size. Explicit terminal actions open Terminal.
   Do not remember Terminal as a durable default or auto-attach on reload.
3. Switching modes preserves the target, label, recents order, composer draft,
   Reader preferences, and Reader scroll/follow state. Switching agents opens
   Reader and resets scroll to the new agent's tail as it does today.
4. Closing Terminal returns to Reader for that same agent. Existing navigation
   away from details remains available; no URL router is introduced.
5. Agent management and Diff remain outside the mode control. Only the active
   mode runs its output transport: Reader polls; Terminal owns one WebSocket.
6. Terminal input is never auto-focused on entry or rotation, avoiding an
   unexpected iOS keyboard. Returning to Reader restores focus to its mode
   button; an explicit tap focuses the composer.

### Reader behavior

- Label the view as a terminal screen snapshot, not a complete conversation or
  append-only log. Keep capture text literal apart from safe ANSI styling.
- Default wrapping to on when no saved preference exists; honor the existing
  `wmhttp:wrap` setting. Keep Wrap off for aligned tables and source output.
- Add a bounded Reader text-size control with named size presets, defaulting
  to the current 12px. Persist a validated preset with `loadPref` / `savePref`;
  invalid stored values fall back safely. Keep inputs at least 16px on mobile.
- Long tokens wrap without causing document-level horizontal overflow.
  Wrapping may disrupt TUI borders and tables; explain this briefly in the UI.
- Retain copy-output, key controls, explicit Send, visibility-gated polling,
  follow-bottom, and Jump to latest. Never submit a draft on a mode change.
- On transient output failures, retain the last snapshot and show an accessible
  output-specific stale/error notice. Dashboard connection state alone does
  not prove that output fetching succeeded. Clear the notice after recovery;
  keep target-gone distinct. No automatic retry of ambiguous input delivery.
- Preserve selection when snapshots are unchanged. Do not promise stable
  selection across changed snapshots or unlimited scrollback history.

### Terminal behavior

- Preserve the server-reported grid by default. Give that grid a real
  horizontally scrollable viewport rather than clipping or wrapping its cells.
  Keep xterm's vertical scrollback separate and avoid body scrolling.
- Show actual grid dimensions and the current display policy. Remove the
  unconditional “original size” label after a successful explicit fit.
- Rename Fit to screen to Resize shared terminal to fit. Show visible warning
  text, not just a tooltip: this may change layout for other tmux clients.
  Require an explicit confirmation before sending each resize request.
- Rotation, container changes, and keyboard opening adjust only the local
  viewport. They must not automatically send `fit`, resize the PTY, or change
  shared tmux windows. No sticky automatic-resize mode in this version.
- Explicit resize measures the visible content area at action time and waits
  for the server's acknowledgment before treating dimensions as confirmed.
  Respect current bounds and throttling. If disconnected, disable resizing.
- Detach immediately on Terminal exit, target change, or detail navigation.
  Clean up the owned session only; never restore geometry by issuing an
  unrequested resize, kill the agent, or replay keystrokes on reconnect.
- Keep a visible Return to Reader action when terminal connection fails or
  the target ends. Never silently attach a different agent.

## Implementation sequence

### 1. Unify target and mode ownership

Files: `src/App.tsx`, `src/features/agent/AgentView.tsx`, and a small shared
mode-control component under `src/features/agent/` if useful.

- Represent detail navigation with one agent identity and an explicit mode,
  using the existing route union rather than parallel unsynchronized states.
  Route all existing open-terminal entry points through the same helper.
- Resolve header labels, actions, Reader, and Terminal against that identity.
  A missing target renders an ended/unavailable state, never another agent.
- Keep the Reader component state mounted while Terminal is active, but pass
  an active flag that cancels/pauses polling and ignores late responses.
  Hide the inactive subtree from display, focus, and accessibility traversal.
- Mount Terminal only when selected, keyed by agent ID. Returning to Reader
  resumes one immediate output fetch and restores its previous follow policy.
- Verify draft retention through existing sessionStorage behavior; do not
  duplicate draft storage. Preserve existing keyboard shortcut exclusions.

Targeted verification: extend `src/features/agent/AgentView.test.tsx` and add
`src/App.test.tsx` for route/target transitions with mocked child transports.

### 2. Finish responsive Reader presentation

Files: `src/features/agent/OutputPane.tsx`, `src/index.css`, and colocated tests.

- Add active-state lifecycle handling, validated text-size preferences,
  retained-snapshot errors, and concise snapshot/wrapping guidance.
- Keep every internal scroll flex child `min-h-0`; constrain output width with
  `min-w-0`. Do not alter shared color palettes or hardcode component colors.
- Verify a scrolled-up Reader remains scrolled up when resumed, while a Reader
  following the tail catches up. Avoid overlapping polls and stale responses
  overwriting newer output during pause/resume or target changes.
- Do not join arbitrary lines, strip meaningful spaces, parse messages from
  screen text, or replace `ansi_up` with unsafe HTML interpolation.

Targeted verification: add `src/features/agent/OutputPane.test.tsx` covering
preferences, polling pause/resume, out-of-order responses, errors/recovery,
follow state, unchanged snapshots, and safe rendering of markup-like text.

### 3. Make Terminal viewport behavior explicit

Files: `src/features/terminal/TerminalView.tsx`, relevant CSS, and tests.

- Introduce a scroll wrapper and an inner grid width derived from xterm's
  measured cell metrics or supported rendering surface. Verify the approach
  against xterm 5.5; do not depend on private `_core` internals or estimate
  character width from font size. Account for the vertical scrollbar.
- Separate measuring available space from resizing the live emulator. Use
  supported FitAddon measurement APIs for an explicit resize proposal; do not
  call `fit.fit()` first and leave a locally resized grid after rejection.
- Observe local layout changes with cleanup-safe listeners/observers. Reuse
  `src/hooks/useVisualViewport.ts` where appropriate, without making viewport
  changes into shared resize commands or adding competing keyboard offsets.
- Add resize confirmation, pending/error feedback, authoritative size labels,
  and robust detach/reconnect cleanup. Review late WebSocket events and rapid
  target/mode switches for cross-target input or orphaned attachments.
- Audit whether attachment itself preserves shared geometry under supported
  tmux sizing policies. If it does not, fix that with owned-client settings
  and disposable-socket tests before claiming non-disruptive terminal entry.
  Do not change global tmux options to force a desired result.

Targeted verification: add `src/features/terminal/TerminalView.test.tsx` using
mocked xterm/FitAddon and WebSocket. Cover no fit on entry/rotation/keyboard,
confirmed fit only, canceled/rejected fit, server dimension acknowledgment,
same-target reconnect, and disposal on exit/target changes.

No API change is planned. If geometry correctness requires a server or
protocol change, edit `shared/types.ts` first where applicable, retain managed
target validation and owned-session checks, and extend the structural fakes.

### 4. Browser and tmux proof

- Add `e2e/reader-terminal.spec.ts` for Reader default, mode controls, draft
  retention, long-line wrapping, font controls, horizontal Terminal scrolling,
  preserved identity, and viewport changes without unexpected resize frames.
- Use a clearly test-only mocked WebSocket for successful terminal browser
  scenarios; keep a separate test proving real fixture mode rejects terminal
  attachment gracefully. Never enable fixture PTY access for an e2e shortcut.
- Exercise real attach/resize/detach behavior on a disposable tmux socket with
  a harmless test process and another attached client. Verify parent window
  selection and dimensions before/after default entry, confirmed resize, and
  exit, including relevant window-size policies. Never use real coding agents.
- Manually verify actual iOS Safari: portrait, landscape, keyboard open/close,
  touch scrolling, text selection/copy, safe areas, background/resume, and
  mode switching. Chromium device emulation is not proof of these behaviors.

## Acceptance criteria

1. Agent detail exposes Reader and Terminal as explicit modes with one target.
2. Reader is the default; opening it never starts a PTY or resizes tmux.
3. Wrapped long lines remain readable in portrait without widening the body;
   Wrap off preserves horizontal scrolling for alignment-sensitive output.
4. Mode changes preserve drafts, Reader position, preferences, and target;
   inactive Reader output polling stops and Terminal exit closes its socket.
5. Default Terminal entry preserves shared window geometry, proven in tmux
   integration tests; unsupported sizing configurations are disclosed rather
   than silently claimed safe.
6. Terminal preserves the grid with usable horizontal scrolling. Rotation and
   keyboard changes never implicitly resize shared windows.
7. A confirmed explicit resize is the only UI path that sends `fit`; displayed
   dimensions reflect acknowledgment, not an optimistic local change.
8. Disconnects and ended targets remain actionable without retargeting,
   silently losing drafts, replaying input, or fabricating empty output.
9. Controls meet 44px touch targets, have visible focus and accessible labels,
   use theme tokens, and work on actual iOS Safari.

## Verification and documentation gate

Before implementation, run the narrow tests for the component being changed;
after each step, rerun those tests. Before declaring implementation complete:

```sh
npm run typecheck && npm test && npm run build && npm run test:e2e
```

Run a second-pass diff review for regressions, missing tests, target identity,
transport cleanup, and accidental shared resizing. If server files change,
also perform read-only `/api/health` and `/api/dashboard` smoke checks. Record
actual commands, test counts, and Safari/tmux results; do not invent proofs.

Update `README.md` to explain both modes, snapshot limitations, preferences,
and shared resize effects. Append a dated amendment to the canonical spec at
`docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md` describing the
implemented changes, rationale, superseded behavior, and verification delta.
Do not rewrite original criteria. This proposal does not change the current
spec or claim that these behaviors already exist. Before editing any existing
untracked file, create a timestamped `.bak` of that file. Do not commit or push.

## Deferred

- Structured agent transcripts, chat bubbles, Markdown message extraction,
  tool-call cards, or heuristic PTY-to-conversation reconstruction.
- Independent live reflow of one shared TUI at desktop and phone widths.
- Automatic shared resizing, pinch-to-scale terminal UX, server-side replay,
  unlimited historical output, or a new authentication/security model.
- Joining tmux soft-wrapped lines: consider separately with explicit capture
  semantics and regression tests; CSS wrapping alone cannot reconstruct them.
