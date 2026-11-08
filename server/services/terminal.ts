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
}

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
        this.cleanup(ws, 'client_detach')
      }
    } catch (err) {
      send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
      this.cleanup(ws, 'error')
    }
  }

  close(ws: WebSocket): void {
    this.cleanup(ws, 'closed')
  }

  private async attach(
    ws: WebSocket,
    msg: Extract<TerminalClientMessage, { type: 'attach' }>,
    send: (m: TerminalServerMessage) => void,
  ): Promise<void> {
    if (this.attached.has(ws)) this.cleanup(ws, 'reattach')
    if (this.cfg.fixtureDir) throw new Error('advanced terminal unavailable in fixture mode')
    if (this.attached.size >= this.cfg.maxOwnedTerminals) {
      throw new Error(`advanced terminal limit reached (${this.cfg.maxOwnedTerminals})`)
    }
    const agent = (await this.discovery.agentTargets()).get(msg.agentId)
    if (!agent) throw new Error('target is not a managed agent')

    const panes = await this.tmux.listPanes()
    const pane = panes.find((p) => p.paneId === msg.agentId)
    if (!pane || pane.dead) throw new Error('agent pane no longer exists')

    const owned = `wmhttp-adv-${randomBytes(4).toString('hex')}`
    await this.tmux.createOwnedGroupedSession(owned, pane.sessionName)
    try {
      // Grouped sessions share windows but keep independent current-window
      // selection; selecting only in the owned session never moves the parent.
      await this.tmux.selectWindow(owned, pane.windowIndex)

      // Preserve existing dimensions by default: attach at the window's current size.
      const cols = clamp(msg.cols, 20, 400) || pane.width
      const rows = clamp(msg.rows, 6, 200) || pane.height
      const pty = spawn('tmux', ['-S', this.tmux.socket, 'attach-session', '-t', owned], {
        name: 'xterm-256color',
        cols: Math.max(cols, pane.width),
        rows: Math.max(rows, pane.height),
        env: { ...process.env, TERM: 'xterm-256color' },
      })
      pty.onData((data) => send({ type: 'output', data }))
      pty.onExit(({ exitCode }) => {
        this.attached.delete(ws)
        void this.tmux.killOwnedSession(owned)
        send({ type: 'detached', reason: `pty exited (${exitCode})` })
      })
      this.attached.set(ws, { pty, ownedSession: owned, agentId: msg.agentId, lastFitAt: 0 })
      send({
        type: 'attached',
        agentId: msg.agentId,
        sessionId: owned,
        cols: Math.max(cols, pane.width),
        rows: Math.max(rows, pane.height),
      })
    } catch (err) {
      await this.tmux.killOwnedSession(owned).catch(() => undefined)
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
    try {
      term.pty.kill()
    } catch {
      // pty already exited
    }
    void this.tmux.killOwnedSession(term.ownedSession)
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'detached', reason } satisfies TerminalServerMessage))
    }
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
