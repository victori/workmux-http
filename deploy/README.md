# Running workmux-http as a service

Templates for macOS (launchd), Linux (systemd), and FreeBSD (rc.d). All
three run the built server — `node dist/server/index.js` — as **the
operator account that owns your tmux socket and repos** (the dashboard
drives per-user `tmux`/`workmux`/`git`, so root-only setups would find
nothing to manage). Configuration lives in one env file, not in the unit.

## 1. Prerequisites (all OSes)

Run everything below **as the service user**:

```sh
node --version            # >= 22 (repo is tested on 26)
npm ci
npm run build             # produces dist/server + dist/public
# Advanced terminal needs the native pty against THIS node binary;
# without it the server still runs and the terminal tab refuses (by design):
npx node-gyp rebuild --directory node_modules/node-pty
command -v tmux workmux git   # must be on the service PATH (probes WARN, never fatal)
```

## 2. Env file (single config source)

```sh
# macOS / FreeBSD
sudo install -m 600 -o "$USER" deploy/workmux-http.env.sample /usr/local/etc/workmux-http.env
# Linux
sudo install -m 600 deploy/workmux-http.env.sample /etc/workmux-http.env
$EDITOR /usr/local/etc/workmux-http.env   # set WORKMUX_ALLOWED_HOSTS, WORKMUX_TMUX_SOCKET, ports, cmds
```

`chmod 600` matters if `WORKMUX_*_CMD` lines embed tokens. Never make
`WORKMUX_ALLOWED_HOSTS=*` the default — see the startup warning.

## 3. Placeholders

Every template uses these; render with `sed` (examples per OS below):

|Placeholder|Meaning|Example|
|---|---|---|
|`@NODE@`|absolute node binary|`/opt/homebrew/bin/node`|
|`@APPDIR@`|checkout containing `dist/`|`/Users/you/workmux-http`|
|`@USER@`|operator account|`you`|
|`@ENVFILE@`|rendered env file|`/usr/local/etc/workmux-http.env`|
|`@BINDIR@`|dir with node+tmux+workmux+git|`/opt/homebrew/bin`|
|`@LOGDIR@`|writable log dir (launchd)|`/Users/you/Library/Logs`|

## 4. macOS — launchd (LaunchAgent)

> **Keep the checkout outside `~/Desktop`, `~/Documents`, and `~/Downloads`.**
> macOS treats those as protected "data vault" folders: a background launchd
> job gets `Operation not permitted` (e.g. `shell-init: error retrieving
> current directory: getcwd…`) with no consent prompt. Put the repo under
> something like `~/src/workmux-http`. (Granting the node binary Full Disk
> Access works but is far broader than needed.)

```sh
NODE=$(command -v node)
BINDIR=$(dirname "$NODE"):$(dirname "$(command -v tmux)")
sed -e "s|@NODE@|$NODE|g" \
    -e "s|@APPDIR@|$HOME/workmux-http|g" \
    -e "s|@ENVFILE@|/usr/local/etc/workmux-http.env|g" \
    -e "s|@BINDIR@|$BINDIR|g" \
    -e "s|@LOGDIR@|$HOME/Library/Logs|g" \
    deploy/launchd/com.workmux.http.plist > ~/Library/LaunchAgents/com.workmux.http.plist
plutil -lint ~/Library/LaunchAgents/com.workmux.http.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.workmux.http.plist
launchctl print gui/$(id -u)/com.workmux.http | head    # status
curl -s http://127.0.0.1:3000/api/health                # smoke
```

- Restart after config edits: `launchctl kickstart -k gui/$(id -u)/com.workmux.http`
- Stop + autostart off: `launchctl bootout gui/$(id -u)/com.workmux.http`
- Logs: `tail -f ~/Library/Logs/workmux-http.log` (launchd does not rotate —
  add a `newsyslog.d` entry for long-lived installs).
- LaunchAgents start at **GUI login**. A headless Mac needs a LaunchDaemon
  with an explicit `WORKMUX_TMUX_SOCKET`; not provided (rarely what you want).
- KeepAlive + `ThrottleInterval=10`: if a stray `npm start` holds port 3000,
  the service exits 1 with an explicit EADDRINUSE message and retries every
  10 s — stop the stray, it recovers.

## 5. Linux — systemd (system unit, drops to operator user)

```sh
NODE=$(command -v node)
sed -e "s|@NODE@|$NODE|g" -e "s|@APPDIR@|/home/you/workmux-http|g" \
    -e "s|@USER@|you|g" -e "s|@ENVFILE@|/etc/workmux-http.env|g" \
    -e "s|@BINDIR@|$(dirname "$NODE")|g" \
    deploy/systemd/workmux-http.service | sudo tee /etc/systemd/system/workmux-http.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now workmux-http
systemctl status workmux-http
journalctl -u workmux-http -f
curl -s http://127.0.0.1:3000/api/health
```

Boots without any login (`User=` handles the drop). Hardening is
deliberately minimal — see the unit comment.

## 6. FreeBSD — rc.d

```sh
NODE=$(command -v node)
sed -e "s|@NODE@|$NODE|g" -e "s|@APPDIR@|/home/you/workmux-http|g" \
    -e "s|@USER@|you|g" -e "s|@ENVFILE@|/usr/local/etc/workmux-http.env|g" \
    -e "s|@BINDIR@|$(dirname "$NODE")|g" \
    deploy/rc.d/workmux_http | sudo tee /usr/local/etc/rc.d/workmux_http >/dev/null
sudo chmod +x /usr/local/etc/rc.d/workmux_http
sudo sysrc workmux_http_enable=YES
sudo service workmux_http start
curl -s http://127.0.0.1:3000/api/health
```

- Filename/PROVIDE is `workmux_http` (underscores): rc.d service keys must
  be shell identifiers, and rcorder matches PROVIDE against the filename.
- Logs: `/var/log/workmux_http.log` (override `workmux_http_log` in
  rc.conf; add newsyslog config for rotation).
- **No respawn**: rc.d won't restart a crashed process. For supervision use
  a watchdog (e.g. a cron `@reboot`/periodic check `service
  workmux_http status || service workmux_http restart`) or run under
  `daemon -r` if you adapt the script.
- `workmux`/`gh` availability on FreeBSD is unproven; the server boots
  degraded with `WARNING:` lines and honest `/api/health` instead of dying.

## 7. Upgrade flow (all OSes)

```sh
git pull && npm ci && npm run build   # as the service user
# then restart: launchctl kickstart -k gui/$UID/com.workmux.http
#               systemctl restart workmux-http
#               service workmux_http restart
```

## Verification status

- launchd template: linted and proven live (bootstrap → `/api/health` →
  `kickstart -k` → duplicate-instance → `bootout`).
- systemd + rc.d templates: static review + `sh -n`/shellcheck only — no
  systemd or FreeBSD runtime was available where these were written.
