import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot, SourceState } from '@shared/types'
import { deriveConnection } from './useDashboard'

const ok = (): SourceState => ({ ok: true, at: Date.now() })
const fail = (error: string): SourceState => ({ ok: false, error, at: Date.now() })

function snapshot(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    observedAt: Date.now(),
    agents: [],
    worktrees: [],
    sources: { workmuxList: ok(), workmuxStatus: ok(), tmux: ok(), git: ok() },
    stale: false,
    ...over,
  }
}

describe('deriveConnection', () => {
  it('is online when all sources are healthy even if agents are idle-stale', () => {
    expect(deriveConnection(snapshot({ stale: true }), null, Date.now())).toBe('online')
  })

  it('is stale when some sources failed', () => {
    const s = snapshot({ stale: true, sources: { workmuxList: ok(), workmuxStatus: ok(), tmux: ok(), git: fail('boom') } })
    expect(deriveConnection(s, null, Date.now())).toBe('stale')
  })

  it('is offline when every source failed', () => {
    const s = snapshot({
      stale: true,
      sources: { workmuxList: fail('a'), workmuxStatus: fail('b'), tmux: fail('c'), git: fail('d') },
    })
    expect(deriveConnection(s, null, Date.now())).toBe('offline')
  })

  it('is offline on fetch error even with a cached snapshot', () => {
    expect(deriveConnection(snapshot(), 'connection refused', Date.now() - 1000)).toBe('offline')
  })

  it('is stale when polling stalled past the timeout', () => {
    expect(deriveConnection(snapshot(), null, Date.now() - 20_000)).toBe('stale')
  })

  it('is connecting before the first snapshot without an error', () => {
    expect(deriveConnection(null, null, null)).toBe('connecting')
    expect(deriveConnection(null, 'nope', null)).toBe('offline')
  })
})
