// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentView, OperationView, PreparedAction } from '@shared/types'
import { api } from '../../lib/api'
import { AgentViewPanel } from './AgentView'

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
}
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true })
}

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, body: Record<string, unknown>) {
      super(String(body.error ?? `http ${status}`))
      this.status = status
      this.body = body
    }
  },
  api: {
    output: vi.fn(() =>
      Promise.resolve({ paneId: '%1', text: '', lines: 0, truncated: false, observedAt: 0 }),
    ),
    message: vi.fn(),
    prepare: vi.fn(),
    execute: vi.fn(),
    operation: vi.fn(),
  },
  terminalWsUrl: () => 'ws://localhost/api/terminal',
}))

const A: AgentView = {
  id: '%1',
  name: 'coder',
  project: 'proj',
  projectPath: '/src/proj',
  worktreeId: 'wt_1',
  status: 'working',
  elapsedSecs: 10,
  title: null,
  agentKind: 'claude',
  session: 'sess',
  windowName: null,
  workdir: '/src/proj',
  git: null,
  updatedTs: 0,
}

const doneOp: OperationView = {
  id: 'op1',
  kind: 'stop',
  target: '%1',
  state: 'done',
  output: 'ok',
  error: null,
  startedAt: 1,
  endedAt: 2,
}

function renderPanel(): void {
  render(
    <AgentViewPanel
      agent={A}
      agents={[A]}
      recents={['%1']}
      connection="online"
      onSwitch={() => undefined}
      onPrevious={() => undefined}
      onOpenDiff={() => undefined}
      onOpenTerminal={() => undefined}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.output).mockResolvedValue({
    paneId: '%1',
    text: '',
    lines: 0,
    truncated: false,
    observedAt: 0,
  })
})

afterEach(cleanup)

describe('AgentView stop action', () => {
  it('prepares stop and shows exact target in the confirm dialog', async () => {
    const prepared: PreparedAction = {
      action: 'stop',
      targetId: '%1',
      targetLabel: 'proj/coder (claude %1)',
      requiresConfirmation: true,
      confirmToken: 'tok9',
      warnings: ['agent is currently working; stopping interrupts it mid-task'],
    }
    vi.mocked(api.prepare).mockResolvedValue(prepared)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('proj/coder (claude %1)')
    expect(dialog.textContent).toContain('agent is currently working')
  })

  it('executes with the prepared token and reports completion', async () => {
    const prepared: PreparedAction = {
      action: 'stop',
      targetId: '%1',
      targetLabel: 'proj/coder (claude %1)',
      requiresConfirmation: true,
      confirmToken: 'tok9',
      warnings: [],
    }
    vi.mocked(api.prepare).mockResolvedValue(prepared)
    vi.mocked(api.execute).mockResolvedValue(doneOp)
    vi.mocked(api.operation).mockResolvedValue(doneOp)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Stop agent' }))
    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stop', targetId: '%1', confirmToken: 'tok9' }),
      ),
    )
    expect(await screen.findByText('✓ agent stopped', {}, { timeout: 3000 })).toBeTruthy()
  })

  it('never executes when the dialog is cancelled', async () => {
    vi.mocked(api.prepare).mockResolvedValue({
      action: 'stop',
      targetId: '%1',
      targetLabel: 'proj/coder (claude %1)',
      requiresConfirmation: true,
      confirmToken: 'tok9',
      warnings: [],
    })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.execute).not.toHaveBeenCalled()
  })
})
