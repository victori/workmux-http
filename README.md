# workmux-http

iPhone-first web dashboard for [workmux](https://github.com)/tmux agent fleets. It
discovers your existing workmux sessions and operates them through native mobile
views — agent output, composer, diffs, hunk staging, confirmations — instead of
embedding the TUI. Served over your VPN; no app login.

## Quick start

```sh
npm install
npx node-gyp rebuild --directory node_modules/node-pty   # approve native build if npm asks
npm run build
npm start                                                 # http://127.0.0.1:3000
```

Dev mode (API watch + Vite with `/api` + WS proxy):

```sh
npm run dev    # http://127.0.0.1:5173
```

`dev` and `start` both bind the API to port 3000 by default — stop one before
starting the other, or run them side by side with e.g.
`WORKMUX_HTTP_PORT=3001 npm run dev` (the Vite proxy follows the same
variable). `/` only serves the SPA from `npm start` (built `dist/public`);
during `npm run dev` open **5173**, not 3000.

Requirements: macOS/Linux with `tmux` on PATH, `workmux` installed, and the
default tmux server already running your sessions (or set
`WORKMUX_TMUX_SOCKET`). Node ≥ 22. Optional: `gh` CLI (PR links), `git`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `WORKMUX_HTTP_BIND` | `127.0.0.1` | Listen address. Wildcard (`0.0.0.0`/`::`) is **refused** unless… |
| `WORKMUX_HTTP_ALLOW_WILDCARD` | unset | …set to `1` to opt in. You MUST also set `WORKMUX_ALLOWED_HOSTS` — the Host allowlist stays enforced, so without it every request 403s. Prefer binding the specific VPN/LAN address instead. |
| `WORKMUX_HTTP_PORT` | `3000` | Port. |
| `WORKMUX_ALLOWED_HOSTS` | localhost + `127.0.0.1`/`[::1]` | Comma-separated exact Host names/IPs accepted (add your VPN/LAN address). Special value `*` accepts **any** Host — see warning below. |
| `WORKMUX_TMUX_SOCKET` | auto (`tmux display-message -p '#{socket_path}'`) | Explicit tmux socket path. |
| `WORKMUX_REPOS` | auto-discovered from workmux | Comma-separated project roots (informational). |
| `WORKMUX_HTTP_FIXTURES` | unset | Directory with `list-all.json`, `status-all.json`, `output-<paneId>.txt` → fixture mode (no tmux/workmux needed; sends are simulated). |

### VPN access model

The server binds loopback only by default. Reach it from your phone by
forwarding the VPN tunnel to loopback (e.g. WireGuard `ListenPort` proxy,
`ssh -L`, or tailscale serve) **or** bind to the VPN interface address and add
it to `WORKMUX_ALLOWED_HOSTS`. There is no app authentication — the network
boundary is the security boundary, so do not expose this on a public interface.
Mutations additionally require a same-origin request carrying
`x-workmux-request: 1`; foreign `Host` headers are rejected (DNS-rebinding
protection).

> ⚠️ **`WORKMUX_ALLOWED_HOSTS=*` disables that last protection.** With no
> login, any page you visit on a network that can reach this port can
> DNS-rebind its own domain to your host, appear same-origin, and drive your
> agents (send messages, merge, remove worktrees). Only use `*` on networks
> you fully trust; the server prints a startup warning when it is set.

## What it shows / does

- **Dashboard** — every managed agent (status, elapsed, branch, dirty state) and
  every worktree (branch, uncommitted, PR link), searchable, filterable,
  sortable; preferences persist per tab.
- **Agent view** — live scrollback capture (2 s poll) opening at the tail
  (latest output), follow-bottom with jump-latest, composer with per-agent
  drafts, one-shot Ctrl chord + key toolbar, literal send via atomic tmux
  paste buffer.
- **Diff view** — WIP (uncommitted) and Review (vs resolved base) unified diffs,
  per-hunk stage / unstage / split / undo, hunk comments, commit (sends a
  literal `commit` to the owning agent), merge behind exact-target confirm.
- **Destructive actions** (merge, remove worktree, stop agent) always
  prepare → show exact target + warnings → confirm token → execute with
  re-validation; each token is single-use. No auto-retry anywhere; uncertain
  delivery is reported as `delivery_unknown` and never silently resent.
- **Advanced terminal** (`Terminal` on an agent) — real interactive tmux pane
  over WebSocket (xterm.js + node-pty) inside an owned grouped session
  (`wmhttp-adv-*`, marked `@wmhttp_owned`), so your desktop window selection is
  never changed. It never resizes the shared window unless you explicitly press
  *Fit to screen* (the button says so). Owned sessions are excluded from the
  dashboard.

## Architecture

```
server/index.ts        routes (fastify), SPA fallback, WS /api/terminal
server/config.ts       env + bounds           server/security.ts  host/origin/header gates
server/exec.ts         argv-only spawn (no shell, ever)
server/adapters/       tmux.ts  workmux.ts  git.ts
server/services/       discovery.ts (2s TTL cache, stale markers)
                       input.ts (dedup, per-pane queue, revalidation)
                       management.ts (confirm tokens, hunks, create/merge/remove)
                       operations.ts (disconnect-safe registry)
                       terminal.ts (owned grouped-session pty attach)
shared/types.ts        single source of API contracts
src/                   React SPA (features/dashboard|agent|worktrees|terminal|palette)
```

Design decisions worth knowing:

- Delivery uses raw `tmux send-keys` / `load-buffer`+`paste-buffer -p -d`, not
  `workmux send` — upstream refuses to send to *waiting* agents (exit 3), and
  the dashboard intentionally allows messaging agents regardless of status.
  workmux is used for lifecycle (`add`, `merge`, `remove`, `close`, `open`).
- Git facts are computed per repository because upstream
  `workmux status --all --git` aborts entirely when any tracked workdir is not
  a git repository (verified against workmux 0.1.280).
- `AgentView.git === null` means *unavailable*, never *clean*. Missing data is
  shown as unavailable, never fabricated.
- The "Data may be outdated" banner reflects source/polling health only.
  Idle agents (past the stale threshold) get per-agent Stale badges — they
  do not claim the dashboard data itself is outdated.

## Verification

- `npm run test` — 110 vitest tests (unit + jsdom component + real-tmux
  integration on a disposable socket + real-git hunk staging).
- `npx playwright test` — 11 e2e tests at iPhone 13 viewport against the
  production build in fixture mode (dashboard, search, sessions, send flow,
  host/origin/header boundary, confirm-token rejection).
- `npm run typecheck` — app + server projects clean.

## workmux TUI parity

| TUI | Dashboard equivalent |
| --- | --- |
| `1-9` window select, `Tab` cycle | tap any agent card / header switcher (no window concept) |
| `d` dashboard | Dashboard tab |
| `o` open worktree | Worktrees tab, card actions, create sheet |
| `p` / `:` command mode | ⌘P / `:` command palette |
| `s` status | connection banner + `/api/health` |
| `/` search | search field (project, name, status, branch) |
| `F`/`f` follow/unfollow | auto-follow at bottom; *Jump to latest* breaks it |
| `i` interrupt | agent header *⏹ Stop* (exact-target confirm) + composer `Ctrl+C` key |
| `Ctrl+u`/`Ctrl+d` scroll | native momentum scroll + jump buttons |
| `Enter` view agent | tap card |
| `j`/`k` navigate | scroll; `j`/`k` work in the palette |
| diff `Tab` | WIP / Review segmented control |
| diff `j`/`k` hunk nav | sidebar hunk chips + scroll |
| diff `c` commit | footer *Commit* (literal `commit` to owning agent) |
| diff `m` merge | footer *Merge* → exact-target confirm dialog |
| patch `y`/`n` | per-hunk *Stage* / *Skip* |
| patch `u` undo | *Undo* per staged hunk/piece |
| patch `s` split | *Split* into stageable pieces |

Known gaps (deliberate or not yet built): preview pane resize (`+`/`-`) —
replaced by wrap toggle and explicit Fit; bulk stage-all (`a`); open file from
patch view (`o`); session rename, rebase, reap-agents, reopen variants; the
workmux sidebar itself; palette navigation-only targets.

## Limits

- Output is polled capture (2 s), not a live stream; the advanced terminal is
  the live path.
- One dashboard poll per browser tab; sends are serialized per pane.
- Advanced terminal requires the native `node-pty` build and refuses to start
  in fixture mode.
- Verified on desktop Chromium (headless, iPhone 13 viewport) and this macOS
  host against real tmux/workmux 0.1.280. **Not** verified on physical
  iPhone/iPad Safari — visual viewport keyboard avoidance and 44 px targets are
  implemented per spec but need a real-device pass.
