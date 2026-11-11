import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import { spawn, type IPty } from 'node-pty'
import type { TerminalClientMessage, TerminalServerMessage } from '../../shared/types.js'
import type { AppConfig } from '../config.js'
import { BOUNDS } from '../config.js'
import type { TmuxLike } from '../adapters/tmux.js'
import type { Discovery } from './discovery.js'

interface OwnedTerminal {
  pty: IPty
  ownedSession: string
  agentId: string
  lastFitAt: number
  /** Pane tmux reports as active in the attached window (may differ from agentId). */
  activePaneId: string | null
  /** Polls the window's active pane so the client can disclose keystroke target changes. */
  paneWatchdog?: NodeJS.Timeout
}

const PANE_WATCHDOG_MS = 2000

const FIT_THROTTLE_MS = 250

/**
 * Optional advanced terminal. Attaches a PTY-backed tmux client through a
 * dedicated grouped session marked @wmhttp_owned. Grouped sessions keep their
 * own current-window selection (verified against tmux), so browsing here never
 * moves the desktop client's window. Closing detaches and removes only the
 * owned session; original sessions/windows/panes/processes are untouched.
 * Dimensions default to the pane's current size; explicit fit resizes the
 * shared window layout (disclosed in the UI).
 */
export class TerminalHub {
  private attached = new Map<WebSocket, OwnedTerminal>()
  private inflight = new Set<WebSocket>()
  private attachGen = new Map<WebSocket, number>()

  constructor(
    private readonly cfg: AppConfig,
    private readonly tmux: TmuxLike,
    private readonly discovery: Discovery,
  ) {}

  ownedSessionNames(): string[] {
    return [...this.attached.values()].map((t) => t.ownedSession)
  }

  /** Kill wmhttp-adv-* sessions left behind by a crash/restart. */
  async sweepOrphans(): Promise<void> {
    if (this.cfg.fixtureDir) return
    const sessions = await this.tmux.listSessions().catch(() => [])
    for (const s of sessions) {
      if (s.name.startsWith('wmhttp-adv-') && s.owned) {
        await this.tmux.killOwnedSession(s.name).catch(() => undefined)
      }
    }
  }

  async handle(ws: WebSocket, msg: TerminalClientMessage): Promise<void> {
    const send = (m: TerminalServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }
    try {
      if (msg.type === 'attach') {
        await this.attach(ws, msg, send)
      } else if (msg.type === 'input') {
        if (msg.data.length > BOUNDS.maxWsMessageBytes) throw new Error('input too large')
        this.attached.get(ws)?.pty.write(msg.data)
      } else if (msg.type === 'fit') {
        this.fit(ws, msg.cols, msg.rows, send)
      } else if (msg.type === 'detach') {
        this.cancelPending(ws)
        this.cleanup(ws, 'client_detach')
      }
    } catch (err) {
      send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
      this.cleanup(ws, 'error')
    }
  }

  close(ws: WebSocket): void {
    this.cancelPending(ws)
    this.cleanup(ws, 'closed')
  }

  /** Invalidate any in-flight attach for this socket (audit F04). */
  private cancelPending(ws: WebSocket): void {
    this.attachGen.set(ws, (this.attachGen.get(ws) ?? 0) + 1)
    this.inflight.delete(ws)
  }

  private async attach(
    ws: WebSocket,
    msg: Extract<TerminalClientMessage, { type: 'attach' }>,
    send: (m: TerminalServerMessage) => void,
  ): Promise<void> {
    if (this.attached.has(ws)) this.cleanup(ws, 'reattach')
    if (this.cfg.fixtureDir) throw new Error('advanced terminal unavailable in fixture mode')
    // Reserve capacity synchronously: pending attaches count toward the
    // limit, so concurrent attaches cannot all pass an attached-only check.
    if (this.attached.size + this.inflight.size >= this.cfg.maxOwnedTerminals) {
      throw new Error(`advanced terminal limit reached (${this.cfg.maxOwnedTerminals})`)
    }
    this.inflight.add(ws)
    const gen = (this.attachGen.get(ws) ?? 0) + 1
    this.attachGen.set(ws, gen)
    // From the reservation onward, every rejection path must release the slot,
    // otherwise the owned-terminal limit stays permanently consumed.
    let owned = ''
    try {
      const agent = (await this.discovery.agentTargets()).get(msg.agentId)
      if (!agent) {
        this.inflight.delete(ws)
        throw new Error('target is not a managed agent')
      }

      const panes = await this.tmux.listPanes()
      const pane = panes.find((p) => p.paneId === msg.agentId)
      if (!pane || pane.dead) {
        this.inflight.delete(ws)
        throw new Error('agent pane no longer exists')
      }
      if (this.attachGen.get(ws) !== gen) {
        // Socket closed or re-attached while dependencies resolved.
        this.inflight.delete(ws)
        return
      }

      owned = `wmhttp-adv-${randomBytes(4).toString('hex')}`
      await this.tmux.createOwnedGroupedSession(owned, pane.sessionName)
      try {
        if (this.attachGen.get(ws) !== gen) {
          await this.tmux.killOwnedSession(owned).catch(() => undefined)
          this.inflight.delete(ws)
          return
        }
        // Grouped sessions share windows but keep independent current-window
        // selection; selecting only in the owned session never moves the parent.
        await this.tmux.selectWindow(owned, pane.windowIndex)

        // Preserve shared geometry on entry: attach at a client size that keeps
        // the window exactly as-is (window height + status row tmux reserves).
        // A larger client request must NOT enlarge the window — that would
        // resize the layout for every other tmux client.
        const geo = await this.tmux.windowGeometry?.(pane.paneId).catch(() => null)
        const cols = clamp(geo?.cols ?? pane.width, 20, 400) || 80
        const rows = clamp(geo?.rows ?? pane.height + 1, 6, 200) || 24
        const pty = spawn('tmux', ['-S', this.tmux.socket, 'attach-session', '-t', owned], {
          name: 'xterm-256color',
          cols,
          rows,
          env: { ...process.env, TERM: 'xterm-256color' },
        })
        pty.onData((data) => send({ type: 'output', data }))
        // Full-session access, disclosed honestly: tmux focuses the window's
        // active pane, which can be a different agent's pane than requested.
        const active = (await this.tmux.activePane?.(`${owned}:${pane.windowIndex}`)) ?? null
        const entry: OwnedTerminal = {
          pty,
          ownedSession: owned,
          agentId: msg.agentId,
          lastFitAt: 0,
          activePaneId: active,
        }
        pty.onExit(({ exitCode }) => {
          if (this.attached.get(ws)?.pty === pty) this.attached.delete(ws)
          clearInterval(entry.paneWatchdog)
          void this.tmux.killOwnedSession(owned).catch(() => undefined)
          send({ type: 'detached', reason: `pty exited (${exitCode})` })
        })
        entry.paneWatchdog = setInterval(() => {
          void (async () => {
            if (this.attached.get(ws) !== entry) return
            const now = await this.tmux.activePane?.(`${owned}:${pane.windowIndex}`).catch(
              () => null,
            )
            if (now && now !== entry.activePaneId) {
              entry.activePaneId = now
              send({ type: 'pane-changed', activePaneId: now })
            }
          })()
        }, PANE_WATCHDOG_MS)
        entry.paneWatchdog.unref?.()
        if (this.attachGen.get(ws) !== gen) {
          // Socket closed or re-attached while the PTY was starting.
          clearInterval(entry.paneWatchdog)
          try {
            pty.kill()
          } catch {
            /* already exited */
          }
          await this.tmux.killOwnedSession(owned).catch(() => undefined)
          this.inflight.delete(ws)
          return
        }
        // Success: the slot moves from inflight to attached.
        this.inflight.delete(ws)
        this.attached.set(ws, entry)
        send({
          type: 'attached',
          agentId: msg.agentId,
          sessionId: owned,
          cols,
          rows,
          activePaneId: active,
        })
      } catch (err) {
        this.inflight.delete(ws)
        await this.tmux.killOwnedSession(owned).catch(() => undefined)
        owned = '' // session already cleaned up; outer handler must not re-kill
        throw err
      }
    } catch (err) {
      // A rejecting dependency must never strand the capacity reservation.
      // If a close or newer attach took over the generation, that flow owns
      // the slot now; an owned session created here still must not be orphaned.
      if (this.attachGen.get(ws) === gen) this.inflight.delete(ws)
      if (owned) void this.tmux.killOwnedSession(owned).catch(() => undefined)
      throw err
    }
  }

  private fit(
    ws: WebSocket,
    cols: number,
    rows: number,
    send: (m: TerminalServerMessage) => void,
  ): void {
    const term = this.attached.get(ws)
    if (!term) return
    const now = Date.now()
    if (now - term.lastFitAt < FIT_THROTTLE_MS) return
    term.lastFitAt = now
    const c = clamp(cols, 20, 400)
    const r = clamp(rows, 6, 200)
    term.pty.resize(c, r)
    send({ type: 'resized', cols: c, rows: r })
  }

  private cleanup(ws: WebSocket, reason: string): void {
    const term = this.attached.get(ws)
    if (!term) return
    this.attached.delete(ws)
    clearInterval(term.paneWatchdog)
    try {
      term.pty.kill()
    } catch {
      // pty already exited
    }
    void this.tmux.killOwnedSession(term.ownedSession).catch(() => undefined)
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'detached', reason } satisfies TerminalServerMessage))
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
