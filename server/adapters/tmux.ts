import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { run, type RunError } from '../exec.js'
import type { KeyName } from '../../shared/types.js'

/** tmux key names for the explicit-key allowlist. */
export const TMUX_KEYS: Record<KeyName, string> = {
  enter: 'Enter',
  esc: 'Escape',
  tab: 'Tab',
  backtab: 'BTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pgup: 'PPage',
  pgdn: 'NPage',
  bspace: 'BSpace',
  space: 'Space',
  'ctrl-c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl-u': 'C-u',
  'ctrl-a': 'C-a',
  'ctrl-e': 'C-e',
  'ctrl-l': 'C-l',
  'ctrl-r': 'C-r',
}

export interface TmuxPane {
  paneId: string
  sessionId: string
  sessionName: string
  windowIndex: number
  windowName: string
  paneIndex: number
  paneActive: boolean
  currentCommand: string
  width: number
  height: number
  dead: boolean
  owned: boolean
}

export interface TmuxSession {
  name: string
  id: string
  groupName: string
  owned: boolean
}

/** Structural surface services depend on; Tmux implements, tests fake. */
export interface TmuxLike {
  readonly socket: string
  ping(): Promise<boolean>
  listSessions(): Promise<TmuxSession[]>
  listPanes(): Promise<TmuxPane[]>
  paneExists(paneId: string): Promise<boolean>
  capturePane(paneId: string, lines: number): Promise<string>
  sendLiteral(paneId: string, text: string): Promise<void>
  sendKeys(paneId: string, keys: string[]): Promise<void>
  killPane(paneId: string): Promise<void>
  createOwnedGroupedSession(name: string, parentSession: string): Promise<void>
  selectWindow(sessionName: string, windowIndex: number): Promise<void>
  /**
   * Client grid that keeps a window at its current size when attached:
   * window height plus the status line tmux reserves for clients.
   */
  windowGeometry?(paneTarget: string): Promise<{ cols: number; rows: number } | null>
  /** Pane id currently active in a session/window target (keystrokes land there). */
  activePane?(target: string): Promise<string | null>
  killOwnedSession(name: string): Promise<void>
  sessionExists(name: string): Promise<boolean>
}

export class Tmux implements TmuxLike {
  constructor(readonly socket: string) {}

  private args(...extra: string[]): string[] {
    return ['tmux', '-S', this.socket, ...extra]
  }

  static async resolveDefaultSocket(): Promise<string> {
    const res = await run(['tmux', 'display-message', '-p', '#{socket_path}'])
    if (res.code !== 0) {
      throw new Error(`cannot resolve tmux socket: ${res.stderr.trim() || `exit ${res.code}`}`)
    }
    return res.stdout.trim()
  }

  async ping(): Promise<boolean> {
    try {
      const res = await run(this.args('list-sessions'))
      return res.code === 0 || /no server running|no sessions/.test(res.stderr)
    } catch {
      return false
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    const res = await run(
      this.args('list-sessions', '-F', '#{session_name}\t#{session_id}\t#{session_group_name}\t#{@wmhttp_owned}'),
    )
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, id, groupName, owned] = line.split('\t')
        return {
          name: name ?? '',
          id: id ?? '',
          groupName: groupName ?? '',
          owned: owned === '1',
        }
      })
  }

  async listPanes(): Promise<TmuxPane[]> {
    const fmt =
      '#{pane_id}\t#{session_name}\t#{session_id}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{?pane_dead,dead,alive}\t#{@wmhttp_owned}'
    const res = await run(this.args('list-panes', '-a', '-F', fmt))
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const f = line.split('\t')
        return {
          paneId: f[0] ?? '',
          sessionName: f[1] ?? '',
          sessionId: f[2] ?? '',
          windowIndex: Number(f[3] ?? -1),
          windowName: f[4] ?? '',
          paneIndex: Number(f[5] ?? -1),
          paneActive: f[6] === '1',
          currentCommand: f[7] ?? '',
          width: Number(f[8] ?? 0),
          height: Number(f[9] ?? 0),
          dead: f[10] === 'dead',
          owned: f[11] === '1',
        }
      })
  }

  async paneExists(paneId: string): Promise<boolean> {
    const res = await run(this.args('display-message', '-p', '-t', paneId, '#{pane_id}'))
    return res.code === 0 && res.stdout.trim() === paneId
  }

  /** Capture pane output with ANSI styling; never selects or resizes anything. */
  async capturePane(paneId: string, lines: number): Promise<string> {
    const res = await run(this.args('capture-pane', '-e', '-p', '-S', `-${lines}`, '-t', paneId))
    if (res.code !== 0) {
      throw new Error(`capture failed: ${res.stderr.trim() || `exit ${res.code}`}`)
    }
    return res.stdout.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  }

  /**
   * Deliver literal text atomically via a tmux buffer paste (bracketed paste).
   * Avoids send-keys option parsing pitfalls and interleaving of long text.
   */
  async sendLiteral(paneId: string, text: string): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wmhttp-'))
    const file = path.join(dir, 'msg')
    const buf = `wmhttp_${randomBytes(6).toString('hex')}`
    try {
      await writeFile(file, text, { mode: 0o600 })
      const load = await run(this.args('load-buffer', '-b', buf, file))
      if (load.code !== 0) {
        throw new Error(`load-buffer failed: ${load.stderr.trim() || `exit ${load.code}`}`)
      }
      const paste = await run(this.args('paste-buffer', '-p', '-d', '-b', buf, '-t', paneId))
      if (paste.code !== 0) {
        throw new Error(`paste-buffer failed: ${paste.stderr.trim() || `exit ${paste.code}`}`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      // paste-buffer -d consumed it on success; on any earlier failure the
      // buffer would otherwise persist in the tmux server.
      await run(this.args('delete-buffer', '-b', buf)).catch(() => undefined)
    }
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const res = await run(this.args('send-keys', '-t', paneId, ...keys))
    if (res.code !== 0) {
      throw new Error(`send-keys failed: ${res.stderr.trim() || `exit ${res.code}`}`)
    }
  }

  async killPane(paneId: string): Promise<void> {
    const res = await run(this.args('kill-pane', '-t', paneId))
    if (res.code !== 0) {
      throw new Error(`kill-pane failed: ${res.stderr.trim() || `exit ${res.code}`}`)
    }
  }

  /** Create an owned session grouped with a parent session. */
  async createOwnedGroupedSession(name: string, parentSession: string): Promise<void> {
    const create = await run(this.args('new-session', '-d', '-s', name, '-t', parentSession))
    if (create.code !== 0) {
      throw new Error(`owned session create failed: ${create.stderr.trim() || `exit ${create.code}`}`)
    }
    const mark = await run(this.args('set-option', '-t', name, '@wmhttp_owned', '1'))
    if (mark.code !== 0) {
      // Unmarked sessions can never be killed by killOwnedSession; don't orphan.
      await run(this.args('kill-session', '-t', name)).catch(() => undefined)
      throw new Error(`failed to mark owned session: ${mark.stderr.trim() || `exit ${mark.code}`}`)
    }
  }

  async selectWindow(sessionName: string, windowIndex: number): Promise<void> {
    const res = await run(this.args('select-window', '-t', `${sessionName}:${windowIndex}`))
    if (res.code !== 0) {
      throw new Error(`select-window failed: ${res.stderr.trim() || `exit ${res.code}`}`)
    }
  }

  async windowGeometry(paneTarget: string): Promise<{ cols: number; rows: number } | null> {
    const res = await run(
      this.args('display-message', '-p', '-t', paneTarget, '#{window_width}x#{window_height}x#{?status,1,0}'),
    )
    if (res.code !== 0) return null
    const m = /^(\d+)x(\d+)x(\d+)$/.exec(res.stdout.trim())
    if (!m) return null
    return { cols: Number(m[1]), rows: Number(m[2]) + Number(m[3]) }
  }

  async activePane(target: string): Promise<string | null> {
    const res = await run(this.args('list-panes', '-t', target, '-F', '#{pane_id}\t#{pane_active}'))
    if (res.code !== 0) return null
    for (const line of res.stdout.split('\n')) {
      const [id, active] = line.split('\t')
      if (id && active === '1') return id
    }
    return null
  }

  async killOwnedSession(name: string): Promise<void> {
    // Double-check ownership marker before killing; never kill unowned sessions.
    const check = await run(this.args('display-message', '-p', '-t', name, '#{?@wmhttp_owned,owned,no}'))
    if (check.code !== 0 || check.stdout.trim() !== 'owned') return
    await run(this.args('kill-session', '-t', name))
  }

  async sessionExists(name: string): Promise<boolean> {
    const res = await run(this.args('has-session', '-t', name))
    return res.code === 0
  }
}

export function isTmuxMissing(err: unknown): boolean {
  return (err as RunError)?.isSpawnFailure === true
}
