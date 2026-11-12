# Service launch scripts — launchd, systemd, FreeBSD rc.d (2026-11-12)

## Goal

Ship template service definitions so `workmux-http` can run unattended on
macOS (launchd LaunchAgent), Linux (systemd system unit), and FreeBSD
(rc.d script), driven by one shared env file, plus a `deploy/README.md`
with render + enable + log instructions per OS. Templates only — no
installer scripts.

## Locked decisions (user-approved)

- **Operator user everywhere.** The app talks to the *user's* tmux socket
  and runs user tools (`workmux`, `git`, commit/push cmds), so the service
  always runs as the operator, never root: LaunchAgent (login session),
  systemd system unit with `User=@USER@`, rc.d drops via `daemon -u`.
- **One env file** `workmux-http.env` (sample shipped) is the single
  config source; units source it rather than duplicating `WORKMUX_*`.
- **Plain templates + README**: placeholders `@NODE@`, `@APPDIR@`,
  `@USER@`, `@ENVFILE@` rendered by documented `sed` one-liners.
- **Verification**: launchd proven live on this Mac; systemd and rc.d are
  static-checked only (no systemd/FreeBSD here) — disclosed, not faked.

## Ground facts from code

- Entry: `node dist/server/index.js` after `npm run build` (`npm start`).
- No SIGTERM handler → default terminate is correct; startup runs
  `terminals.sweepOrphans()` so a restart cleans orphaned `wmhttp-adv-*`
  sessions. `EADDRINUSE` exits 1 with a clear message → units need restart
  backoff so a duplicate instance can't crash-loop tightly.
- Config = `WORKMUX_*` env (SPEC §7 table). Prereq probes + discovery shell
  out to `tmux`/`workmux`/`git` by PATH → **PATH must contain them** in the
  service environment (launchd/rc.d start with a minimal PATH).
- Node ≥ 22 required (repo runs 26); `node-pty` native build is per-Node →
  the service user must have built against the same Node binary the unit
  runs; otherwise the advanced terminal refuses (documented degradation).
- Wildcard bind stays refused without `WORKMUX_HTTP_ALLOW_WILDCARD=1`;
  Host allowlist still enforced — units change nothing about security.

## Files (all new; one integrator owns the set)

|File|Contents|
|---|---|
|`deploy/workmux-http.env.sample`|Every `WORKMUX_*` from SPEC §7, commented, with the VPN-host bind example; header: `chmod 600` if commit/push cmds embed tokens|
|`deploy/launchd/com.workmux.http.plist`|LaunchAgent template: `RunAtLoad`, `KeepAlive` + `ThrottleInterval=10`, `WorkingDirectory=@APPDIR@`, `ProgramArguments` = `/bin/sh -c 'set -a; . @ENVFILE@; exec @NODE@ dist/server/index.js'`, `PATH` in `EnvironmentVariables`, stdout/err → `~/Library/Logs/workmux-http.log`|
|`deploy/systemd/workmux-http.service`|System unit: `User=@USER@`, `WorkingDirectory=@APPDIR@`, `ExecStart=@NODE@ dist/server/index.js`, `EnvironmentFile=@ENVFILE@`, `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=60`/`StartLimitBurst=3`, `PATH` via `Environment=`; deliberately minimal hardening with an inline note (needs user home for tmux socket/repos → `ProtectHome`/`PrivateTmp` would break it)|
|`deploy/rc.d/workmux-http`|FreeBSD rc.subr script: `KEYWORD: REQUIRE: LOGIN` (user home + tmux socket), `daemon -u @USER@ -p /var/run/workmux-http.pid /bin/sh -c 'set -a; . @ENVFILE@; exec @NODE@ dist/server/index.js'`; rc.conf knobs `workmux_http_enable/_user/_dir/_env/_node` with `${var:-default}` so the shipped file runs unmodified after placeholder render|
|`deploy/README.md`|Per-OS: prerequisites (Node ≥22, `npm ci && npm run build` + node-pty rebuild as the service user), sed render lines, install + enable + status + logs + disable, fixture-mode note, upgrade note (rebuild then restart unit)|
|`README.md` (edit)|One "Run as a service" pointer line to `deploy/README.md` near Quick start|

No `docs/SPEC.md` change: no routes, env vars, error codes, invariants, WS
protocol, or state machines change (existing env table already covers every
variable the units set) → `server/docs.spec.test.ts` unaffected.

## Design notes / risks

- **launchd has no EnvironmentFile** → the plist sources the env file via a
  `sh -c` wrapper; `launchctl` still owns the process and KeepAlive.
- **LaunchAgent requires a GUI login.** Headless Mac would need a
  LaunchDaemon + explicit `WORKMUX_TMUX_SOCKET` — out of scope, noted.
- **systemd `User=` + tmux socket**: socket path is resolved by invoking
  `tmux` itself, so PATH correctness (not `XDG_RUNTIME_DIR`) is the
  requirement; env file sets `WORKMUX_TMUX_SOCKET` explicitly in the sample.
- **rc.d has no respawn** — `daemon` restarts nothing; document a
  `powerd`/cron watchdog alternative or accept manual restart.
- **Cross-OS honesty**: `workmux` is the project's own tool; Linux/FreeBSD
  availability of `workmux`/`gh` is unproven — prereq probes will WARN at
  startup rather than fail, so units still boot degraded (by design).
- Log growth: launchd files don't rotate → note `newsyslog`/`newsyslog`
  config suggestion in deploy/README.

## Verification

1. `plutil -lint` on the rendered plist.
2. **Live on this Mac**: render env + plist for this repo, `launchctl
   bootstrap gui/$UID`, `curl 127.0.0.1:3000/api/health` (expect
   `ok` + degraded-source fields), `launchctl kickstart -k` → health again
   (restart works), duplicate-instance test (second manual `npm start`
   hits EADDRINUSE while service holds port → unit stays healthy), then
   `launchctl bootout` to leave nothing running. Read-only smoke only —
   no agent messages sent.
3. systemd: static review against systemd 250+ directive semantics
   (`systemd-analyze verify` unavailable on darwin — stated limitation;
   offer deferred run on a Linux host if the user later grants ssh).
4. rc.d: `sh -n` + `shellcheck` (if installed) + rc.subr directive review
   (`start_cmd`/`pidfile`/`daemon -u -p` shape).
5. Docs: README pointer renders; no test-count changes (no vitest files
   added — these are configuration artifacts, disclosed as such).

## Order & dependencies

env sample → 3 unit templates (independent) → deploy/README + README
pointer → live launchd proof → static checks → report. Single integrator;
no subagents needed (small, interdependent-by-convention file set).

## Verification & deviations (implementation, 2026-11-12)

- launchd proven live: `plutil -lint` OK; bootstrap → `/api/health`
  `ok:true` (tmux + workmux reachable); `kickstart -k` → health again;
  duplicate instance exited 1 with the EADDRINUSE message while the service
  stayed healthy; `bootout` released the port; all temp artifacts removed,
  nothing left running. Proof ran on port 3199 (3000 held by a live dev
  instance) and from a `/tmp` copy of `dist/` + `node_modules/`.
- **Deviation (live finding):** the first bootstrap against the real
  checkout failed with `shell-init: getcwd … Operation not permitted` —
  macOS TCC denies background launchd jobs the `~/Desktop` data vault with
  no prompt. Documented in `deploy/README.md` §4 + plist comment: keep the
  checkout outside Desktop/Documents/Downloads.
- **Deviation (filename):** rc.d script ships as `workmux_http` (underscore),
  not `workmux-http` — rc.conf keys must be shell identifiers and rcorder
  matches PROVIDE against the filename. Noted in the script + README §6.
- Static: `sh -n` clean on the rc.d script (shellcheck not installed here);
  systemd unit reviewed against systemd 250+ directive semantics —
  `systemd-analyze verify` unavailable on darwin (disclosed, not faked).
- No vitest/e2e impact (configuration-only change; no SPEC tables touched).
