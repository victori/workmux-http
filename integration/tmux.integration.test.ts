import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { run } from '../server/exec.js'
import { Tmux } from '../server/adapters/tmux.js'
import type { AppConfig } from '../server/config.js'
import type { Discovery } from '../server/services/discovery.js'
import type { TerminalClientMessage, TerminalServerMessage } from '../shared/types.js'
import type { WebSocket as WsSocket } from 'ws'

// terminal.js statically loads node-pty; when the native build is absent the
// geometry audit skips instead of failing the file.
const terminalHubMod = await import('../server/services/terminal.js').catch(() => null)

/**
 * Integration checks against a REAL tmux server on a dedicated socket
 * (`wmhttp-itest`), fully isolated from user sessions. Real tmux behavior
 * (selection semantics, paste, key delivery) cannot be verified deterministically
 * in-process, so genuine timing is intentional here.
 */

const tmuxAvailable = await run(['tmux', '-V'])
  .then((r) => r.code === 0)
  .catch(() => false)

const SOCKET = tmuxAvailable
  ? await run(['tmux', 'display-message', '-p', '#{socket_path}'])
      .then((r) => `${r.stdout.trim().replace(/\/[^/]+$/, '')}/wmhttp-itest`)
      .catch(() => '/tmp/wmhttp-itest')
  : '/tmp/wmhttp-itest'
const SESSION = 'itest-main'
const OTHER = 'itest-other'

async function tmuxCli(...args: string[]): Promise<string> {
  const res = await run(['tmux', '-S', SOCKET, ...args])
  if (res.code !== 0) throw new Error(`tmux ${args.join(' ')}: ${res.stderr.trim()}`)
  return res.stdout
}

function tmux(): Tmux {
  return new Tmux(SOCKET)
}

beforeAll(async () => {
  if (!tmuxAvailable) return
  await run(['tmux', '-S', SOCKET, 'kill-server'])
  await tmuxCli('new-session', '-d', '-s', SESSION, '-x', '120', '-y', '30', '-n', 'w1')
  await tmuxCli('new-window', '-d', '-t', `${SESSION}:1`, '-n', 'w2')
  await tmuxCli('new-session', '-d', '-s', OTHER, '-x', '100', '-y', '28')
  await tmuxCli('select-window', '-t', `${SESSION}:w1`)
})

afterAll(async () => {
  if (!tmuxAvailable) return
  await run(['tmux', '-S', SOCKET, 'kill-server'])
})

describe.skipIf(!tmuxAvailable)('non-selecting capture and input', () => {
  test('should capture and send without changing active window/pane or size elsewhere', async () => {
    const before = await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_active}|#{pane_active}|#{window_width}x#{window_height}')
    const panes = await tmux().listPanes()
    const otherPane = panes.find((p) => p.sessionName === OTHER)!
    await tmux().capturePane(otherPane.paneId, 100)
    await tmux().sendLiteral(otherPane.paneId, 'literal: 你好 <b> & "q"')
    await tmux().sendKeys(otherPane.paneId, ['Enter'])
    const after = await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_active}|#{pane_active}|#{window_width}x#{window_height}')
    expect(after).toBe(before)
    const captured = await tmux().capturePane(otherPane.paneId, 20)
    expect(captured).toContain('literal:')
  })

  test('should deliver explicit keys (arrow recalls history)', async () => {
    const panes = await tmux().listPanes()
    const pane = panes.find((p) => p.sessionName === SESSION)!
    await tmux().sendLiteral(pane.paneId, 'hist-probe')
    await tmux().sendKeys(pane.paneId, ['Enter'])
    await tmux().sendKeys(pane.paneId, ['Up'])
    const captured = await tmux().capturePane(pane.paneId, 10)
    expect(captured).toContain('hist-probe')
  })

  test('should report missing panes via paneExists', async () => {
    expect(await tmux().paneExists('%999999')).toBe(false)
  })
})

describe.skipIf(!tmuxAvailable)('grouped session isolation', () => {
  test('should keep grouped session window selection independent from parent', async () => {
    const owned = 'wmhttp-adv-itest'
    await tmux().createOwnedGroupedSession(owned, SESSION)
    const parentWindowBefore = await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_index}:#{window_name}')
    await tmuxCli('new-window', '-d', '-t', `${owned}:9`, '-n', 'adv')
    await tmux().selectWindow(owned, 9)
    const ownedWindow = await tmuxCli('display-message', '-p', '-t', owned, '#{window_name}')
    const parentWindowAfter = await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_index}:#{window_name}')
    expect(ownedWindow.trim()).toBe('adv')
    expect(parentWindowAfter).toBe(parentWindowBefore)
    await tmux().killOwnedSession(owned)
    expect(await tmux().sessionExists(owned)).toBe(false)
  })

  test('should refuse to kill sessions lacking the ownership marker', async () => {
    await tmux().killOwnedSession(OTHER)
    expect(await tmux().sessionExists(OTHER)).toBe(true)
  })

  test('should list owned sessions for discovery exclusion', async () => {
    const owned = 'wmhttp-adv-itest2'
    await tmux().createOwnedGroupedSession(owned, SESSION)
    const sessions = await tmux().listSessions()
    expect(sessions.find((s) => s.name === owned)?.owned).toBe(true)
    await tmux().killOwnedSession(owned)
  })
})

class FakeWs {
  readyState = 1
  /** Real WebSocket exposes OPEN on instances; hub checks ws.OPEN. */
  OPEN = 1
  messages: TerminalServerMessage[] = []
  send(s: string): void {
    this.messages.push(JSON.parse(s) as TerminalServerMessage)
  }
  close(): void {
    this.readyState = 3
  }
  of(type: TerminalServerMessage['type']): TerminalServerMessage | undefined {
    return [...this.messages].reverse().find((m) => m.type === type)
  }
}

async function pollUntil(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 100))
  }
}

const geometrySuite = tmuxAvailable && terminalHubMod !== null
describe.skipIf(!geometrySuite)('advanced terminal geometry audit', () => {
  test('should attach at exact pane size, resize only when asked, and clean up', async () => {
    const panes = await tmux().listPanes()
    const pane = panes.find((p) => p.sessionName === SESSION && p.windowIndex === 0)!
    const hub = new terminalHubMod!.TerminalHub(
      { fixtureDir: null, maxOwnedTerminals: 2 } as unknown as AppConfig,
      tmux(),
      { agentTargets: async () => new Map([[pane.paneId, {}]]) } as unknown as Discovery,
    )
    const sizeBefore = await tmuxCli(
      'display-message', '-p', '-t', `${SESSION}:w1`,
      '#{window_width}x#{window_height}',
    )
    const parentActiveBefore = await tmuxCli(
      'display-message', '-p', '-t', SESSION, '#{window_index}',
    )

    const ws = new FakeWs()
    // Client hints are deliberately larger than the pane: entry must ignore them.
    await hub.handle(ws as unknown as WsSocket, { type: 'attach', agentId: pane.paneId, cols: 200, rows: 100 })
    const attached = ws.of('attached')
    // rows = window height + status row: attaching keeps the window fixed.
    expect(attached).toMatchObject({ cols: pane.width, rows: pane.height + 1 })
    const ownedName = (attached as { sessionId: string }).sessionId
    expect(ownedName).toMatch(/^wmhttp-adv-/)

    // Give the tmux client a moment to register, then verify nothing moved.
    await new Promise((r) => setTimeout(r, 400))
    expect(await tmuxCli('display-message', '-p', '-t', `${SESSION}:w1`, '#{window_width}x#{window_height}')).toBe(sizeBefore)
    expect(await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_index}')).toBe(parentActiveBefore)

    // Explicit fit is the only path that changes the shared window.
    hub.handle(ws as unknown as WsSocket, { type: 'fit', cols: 150, rows: 40 } as TerminalClientMessage)
    expect(ws.of('resized')).toMatchObject({ cols: 150, rows: 40 })
    await pollUntil(async () => {
      const s = await tmuxCli('display-message', '-p', '-t', `${SESSION}:w1`, '#{window_width}x#{window_height}')
      return s.trim() === '150x39'
    })
    expect(await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_index}')).toBe(parentActiveBefore)

    // Detach kills the owned session; the resized window persists (disclosed).
    hub.handle(ws as unknown as WsSocket, { type: 'detach' } as TerminalClientMessage)
    expect(ws.of('detached')).toBeTruthy()
    await pollUntil(async () => !(await tmux().sessionExists(ownedName)))
    expect(await tmuxCli('display-message', '-p', '-t', SESSION, '#{window_index}')).toBe(parentActiveBefore)
  })
})
