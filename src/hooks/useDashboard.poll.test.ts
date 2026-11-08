// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot } from '@shared/types'
import { api } from '../lib/api'
import { useDashboard } from './useDashboard'

vi.mock('../lib/api', () => ({
  api: { dashboard: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`http ${status}`)
    }
  },
}))

const snap: DashboardSnapshot = {
  observedAt: Date.now(),
  agents: [],
  worktrees: [],
  sources: {
    workmuxList: { ok: true, at: Date.now() },
    workmuxStatus: { ok: true, at: Date.now() },
    tmux: { ok: true, at: Date.now() },
    git: { ok: true, at: Date.now() },
  },
  stale: false,
}

const mock = vi.mocked(api)

beforeEach(() => {
  vi.useFakeTimers()
  mock.dashboard.mockResolvedValue(snap)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useDashboard pause', () => {
  it('skips interval polls while paused and forces one on resume', async () => {
    const { rerender } = renderHook(({ p }: { p: boolean }) => useDashboard(p), { initialProps: { p: true } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // The initial fetch still runs so the agent view has data.
    expect(mock.dashboard).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mock.dashboard).toHaveBeenCalledTimes(1)

    rerender({ p: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mock.dashboard).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100)
    })
    expect(mock.dashboard.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('reports online immediately after resume (no stale flash)', async () => {
    const { rerender, result } = renderHook(({ p }: { p: boolean }) => useDashboard(p), {
      initialProps: { p: true },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.connection).toBe('online')
    // Simulate a long paused gap: lastOkAt ages past the stale threshold
    // (a re-render — e.g. terminal WS traffic — recomputes it as stale).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    rerender({ p: true })
    expect(result.current.connection).toBe('stale')
    rerender({ p: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.connection).toBe('online')
  })
})
