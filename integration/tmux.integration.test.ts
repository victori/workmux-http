import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { run } from '../server/exec.js'
import { Tmux } from '../server/adapters/tmux.js'

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
