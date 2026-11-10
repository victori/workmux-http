// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OperationView, PreparedSweep, SweepCandidate, SweepScan } from '@shared/types'
import { SweepSheet } from './SweepSheet'
import { api } from '../../lib/api'

// vitest + jsdom on this toolchain don't expose Web Storage; shim it.
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

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig() as object),
  ApiError: class extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, body: Record<string, unknown> = {}) {
      super(String(body.error ?? `http ${status}`))
      this.status = status
      this.body = body
    }
  },
  api: {
    scanSweep: vi.fn(),
    prepareSweep: vi.fn(),
    executeSweep: vi.fn(),
    operation: vi.fn(),
  },
}))

function candidate(id: string, overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    worktreeId: id,
    targetLabel: `proj/${id.slice(-4)}`,
    branch: `feat/${id.slice(-4)}`,
    path: `/repos/proj/.worktrees/${id.slice(-4)}`,
    reason: 'pr_merged',
    blockers: [],
    warnings: [],
    ...overrides,
  }
}

const eligibleA = candidate('wt_aaaa')
const blockedB = candidate('wt_bbbb', { reason: null, blockers: ['uncommitted changes'] })
const eligibleC = candidate('wt_cccc', { reason: 'upstream_gone' })
const CANDIDATES = [eligibleA, blockedB, eligibleC]

function scanRunning(id: string): OperationView {
  return { id, kind: 'sweep-scan', target: 'scan:3', state: 'running', output: null, error: null, startedAt: 0, endedAt: null }
}

function scanDone(id: string, candidates: SweepCandidate[]): OperationView {
  const scan: SweepScan = { type: 'sweep_scan', candidates, expiresAt: Date.now() + 300_000 }
  return { ...scanRunning(id), state: 'done', output: '2 clean', result: scan, endedAt: 1 }
}

function prepared(targets: SweepCandidate[], keepBranches = true): PreparedSweep {
  return {
    confirmToken: 'a'.repeat(24),
    expiresAt: Date.now() + 300_000,
    targets,
    keepBranches,
    warnings: ['Removal deletes the worktree directory, including Git-ignored files.'],
  }
}

function sweepRunning(id: string): OperationView {
  return { id, kind: 'sweep', target: 'sweep:2', state: 'running', output: null, error: null, startedAt: 0, endedAt: null }
}

function sweepDone(id: string): OperationView {
  return {
    ...sweepRunning(id),
    state: 'failed',
    output: '1 removed, 0 skipped, 0 failed, 1 unknown',
    error: '1 removed, 0 skipped, 0 failed, 1 unknown',
    result: {
      type: 'sweep',
      items: [
        { worktreeId: 'wt_aaaa', targetLabel: 'proj/aaaa', state: 'removed', message: null },
        { worktreeId: 'wt_cccc', targetLabel: 'proj/cccc', state: 'unknown', message: 'removal outcome uncertain (exit 124)' },
      ],
    },
    endedAt: 2,
  }
}

async function flush(ms = 1000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function openSelecting(): Promise<void> {
  vi.mocked(api.scanSweep).mockResolvedValue(scanRunning('scan-1'))
  vi.mocked(api.operation).mockResolvedValue(scanDone('scan-1', CANDIDATES))
  render(<SweepSheet worktreeIds={['wt_aaaa', 'wt_bbbb', 'wt_cccc']} onClose={() => undefined} onChanged={() => undefined} />)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  vi.mocked(api.scanSweep).mockReset()
  vi.mocked(api.prepareSweep).mockReset()
  vi.mocked(api.executeSweep).mockReset()
  vi.mocked(api.operation).mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SweepSheet', () => {
  it('starts with no cleanup targets selected', async () => {
    await openSelecting()
    expect(screen.getByRole('checkbox', { name: 'proj/aaaa' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'proj/bbbb' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'proj/cccc' })).not.toBeChecked()
    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument()
  })

  it('selects only eligible rows in the scanned scope', async () => {
    await openSelecting()
    fireEvent.click(screen.getByRole('button', { name: /select eligible/i }))
    expect(screen.getByRole('checkbox', { name: 'proj/aaaa' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'proj/bbbb' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'proj/cccc' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'proj/bbbb' })).toBeDisabled()
  })

  it('ignores repeat clicks while review or removal is in flight', async () => {
    await openSelecting()
    fireEvent.click(screen.getByRole('button', { name: /select eligible/i }))
    let resolveGate!: (p: PreparedSweep) => void
    const gate = new Promise<PreparedSweep>((r) => {
      resolveGate = r
    })
    vi.mocked(api.prepareSweep).mockReturnValue(gate)
    fireEvent.click(screen.getByRole('button', { name: /review selection/i }))
    fireEvent.click(screen.getByRole('button', { name: /review selection/i }))
    expect(vi.mocked(api.prepareSweep)).toHaveBeenCalledTimes(1)
    resolveGate(prepared([eligibleA, eligibleC]))
    await flush(0)
    fireEvent.click(screen.getByRole('checkbox', { name: /acknowledge warnings/i }))
    let resolveExecute!: (op: OperationView) => void
    const egate = new Promise<OperationView>((r) => {
      resolveExecute = r
    })
    vi.mocked(api.executeSweep).mockReturnValue(egate)
    fireEvent.click(screen.getByRole('button', { name: /remove 2 worktrees/i }))
    fireEvent.click(screen.getByRole('button', { name: /remove 2 worktrees/i }))
    expect(vi.mocked(api.executeSweep)).toHaveBeenCalledTimes(1)
    resolveExecute(sweepRunning('op-x'))
    vi.mocked(api.operation).mockResolvedValue(sweepRunning('op-x'))
    await flush(0)
    expect(screen.getByRole('status').textContent).toMatch(/removing|running/i)
  })

  it('keeps branches by default', async () => {
    await openSelecting()
    const keep = screen.getByRole('checkbox', { name: /keep local branches/i })
    expect(keep).toBeChecked()
  })

  it('invalidates confirmation when the selection changes', async () => {
    await openSelecting()
    fireEvent.click(screen.getByRole('button', { name: /select eligible/i }))
    vi.mocked(api.prepareSweep).mockResolvedValue(prepared([eligibleA, eligibleC]))
    fireEvent.click(screen.getByRole('button', { name: /review selection/i }))
    await flush(0)
    expect(screen.getByText(/will be removed/i)).toBeInTheDocument()
    expect(vi.mocked(api.prepareSweep)).toHaveBeenCalledTimes(1)

    // changing keepBranches invalidates the review (prepare must re-run with
    // the new mode; ancestry is re-evaluated server-side)
    fireEvent.click(screen.getByRole('checkbox', { name: /keep local branches/i }))
    expect(screen.queryByText(/will be removed/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /review selection/i })).toBeInTheDocument()
  })

  it('does not treat 202 as removal success', async () => {
    await openSelecting()
    fireEvent.click(screen.getByRole('button', { name: /select eligible/i }))
    vi.mocked(api.prepareSweep).mockResolvedValue(prepared([eligibleA, eligibleC]))
    fireEvent.click(screen.getByRole('button', { name: /review selection/i }))
    await flush(0)
    vi.mocked(api.executeSweep).mockResolvedValue(sweepRunning('op-x'))
    vi.mocked(api.operation)
      .mockResolvedValueOnce(sweepRunning('op-x'))
      .mockResolvedValue(sweepDone('op-x'))
    fireEvent.click(screen.getByRole('checkbox', { name: /acknowledge warnings/i }))
    fireEvent.click(screen.getByRole('button', { name: /remove 2 worktrees/i }))
    await flush(0)

    // accepted ≠ done: progress view, no success claim
    expect(screen.getByRole('status').textContent).toMatch(/removing|running/i)
    expect(screen.queryByText(/all .* removed/i)).not.toBeInTheDocument()

    await flush(1000)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('proj/aaaa')
    expect(status.textContent).toMatch(/removed/)
    expect(status.textContent).toMatch(/uncertain|unknown/i)
    expect(sessionStorage.getItem('wmhttp-tab:sweepOperationId')).not.toBeNull()
  })

  it('resumes polling a retained sweep operation', async () => {
    sessionStorage.setItem('wmhttp-tab:sweepOperationId', JSON.stringify('op-retained'))
    vi.mocked(api.operation)
      .mockResolvedValueOnce({
        ...sweepRunning('op-retained'),
        result: {
          type: 'sweep',
          items: [{ worktreeId: 'wt_aaaa', targetLabel: 'proj/aaaa', state: 'running', message: null }],
        },
      })
      .mockResolvedValue(sweepDone('op-retained'))
    const onChanged = vi.fn()
    render(<SweepSheet worktreeIds={['wt_aaaa', 'wt_bbbb', 'wt_cccc']} onClose={() => undefined} onChanged={onChanged} />)
    expect(vi.mocked(api.scanSweep)).not.toHaveBeenCalled()
    await flush(1000)
    expect(vi.mocked(api.operation)).toHaveBeenCalledWith('op-retained')
    expect(screen.getByRole('status').textContent).toMatch(/proj\/aaaa/)
    await flush(1000)
    expect(screen.getByRole('status').textContent).toMatch(/uncertain|unknown/i)
    expect(onChanged).toHaveBeenCalled()
  })

  it('reports a retained-but-missing operation honestly and clears the id', async () => {
    sessionStorage.setItem('wmhttp-tab:sweepOperationId', JSON.stringify('op-gone'))
    const { ApiError } = await import('../../lib/api')
    vi.mocked(api.operation).mockRejectedValue(new ApiError(404, { error: 'operation_not_found' }))
    render(<SweepSheet worktreeIds={['wt_aaaa']} onClose={() => undefined} onChanged={() => undefined} />)
    await flush(1000)
    expect(screen.getByRole('status').textContent).toMatch(/unknown|rescan/i)
    expect(sessionStorage.getItem('wmhttp-tab:sweepOperationId')).toBeNull()
    expect(vi.mocked(api.executeSweep)).not.toHaveBeenCalled()
  })
})
