import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { GithubStatus } from '../../shared/types.js'
import { GithubStatusService } from './github-status.js'
import type { GithubLike, GithubRequest } from '../adapters/github.js'

const HEAD = 'a'.repeat(40)
const target: GithubRequest = {
  worktreePath: '/wt/x',
  headRepository: 'acme/widgets',
  configuredBaseRepository: 'acme/widgets',
  branch: 'feat/demo',
  headOid: HEAD,
}

const readyStatus: GithubStatus = {
  state: 'ready',
  pr: {
    number: 1,
    title: 'Demo',
    url: 'https://github.com/acme/widgets/pull/1',
    state: 'open',
    review: 'review_required',
    headOid: HEAD,
    headRepository: 'acme/widgets',
    baseRepository: 'acme/widgets',
    baseBranch: 'main',
  },
  ci: {
    state: 'passing',
    commitOid: HEAD,
    complete: true,
    counts: { passing: 1, failing: 0, pending: 0, neutral: 0, unknown: 0 },
    checks: [{ name: 'build', state: 'passing', url: null }],
  },
  observedAt: 1000,
  attemptedAt: 1000,
  error: null,
}

const unavailableStatus = (error: string): GithubStatus => ({
  state: 'unavailable',
  pr: null,
  ci: null,
  observedAt: null,
  attemptedAt: 1000,
  error,
})

/** Provider whose reads resolve only when the test resolves them; resolveNext
 * returns the gate promise so awaiting it runs the service's `.then` first. */
function deferredProvider() {
  const calls: GithubRequest[] = []
  const gates: Array<{ resolve: (v: GithubStatus) => void; promise: Promise<GithubStatus> }> = []
  const provider: GithubLike = {
    read: (request) => {
      calls.push(request)
      const gate = Promise.withResolvers<GithubStatus>()
      gates.push(gate)
      return gate.promise
    },
  }
  return { provider, calls, resolveNext: (v: GithubStatus) => gates.shift()?.resolve(v) ?? Promise.resolve() }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GithubStatusService freshness', () => {
  test('should not block discovery on a pending GitHub request', async () => {
    const pending = Promise.withResolvers<GithubStatus>()
    const service = new GithubStatusService({ read: () => pending.promise })
    expect(service.view(target).state).toBe('loading')
    pending.resolve(readyStatus)
    await service.fresh(target)
    expect(service.view(target).state).toBe('ready')
  })

  test('should preserve last good PR data with a stale marker', async () => {
    let result = readyStatus
    const provider = { read: vi.fn(async () => result) }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    expect(service.view(target).state).toBe('ready')

    vi.advanceTimersByTime(60_001)
    result = unavailableStatus('rate limited')
    expect(service.view(target).state).toBe('stale')
    await service.fresh(target)
    // Background failure keeps the last-good data, still stale.
    const afterFailure = service.view(target)
    expect(afterFailure.state).toBe('stale')
    expect(afterFailure.pr?.number).toBe(1)
    expect(provider.read).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(14_000)
    expect(service.view(target).state).toBe('stale')
    expect(provider.read).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1_000)
    service.view(target)
    expect(provider.read).toHaveBeenCalledTimes(3)
  })

  test('should retry missing gh after backoff', async () => {
    let calls = 0
    const provider: GithubLike = {
      read: async () => {
        calls += 1
        return unavailableStatus('gh CLI not available')
      },
    }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    expect(calls).toBe(1)
    // Within the failure backoff: no new provider call.
    service.view(target)
    await vi.waitFor(() => expect(calls).toBe(1))
    vi.advanceTimersByTime(15_001)
    service.view(target)
    await vi.waitFor(() => expect(calls).toBe(2))
  })

  test('should isolate an older HEAD refresh', async () => {
    const { provider, calls, resolveNext } = deferredProvider()
    const service = new GithubStatusService(provider)
    const otherHead: GithubRequest = { ...target, headOid: 'b'.repeat(40) }
    service.retain([target, otherHead])
    service.view(target)
    service.view(otherHead)
    expect(calls.length).toBe(2)
    await resolveNext(readyStatus)
    expect(service.view(otherHead).state).toBe('loading')
    expect(service.view(target).state).toBe('ready')
  })

  test('should share in-flight work for the identical key only', async () => {
    const { provider, calls, resolveNext } = deferredProvider()
    const service = new GithubStatusService(provider)
    service.view(target)
    service.view({ ...target })
    expect(calls.length).toBe(1)
    const fresh = service.fresh(target)
    await resolveNext(readyStatus)
    await fresh
    expect(service.view(target).state).toBe('ready')
  })

  test('should discard late completions for departed keys', async () => {
    const { provider, resolveNext } = deferredProvider()
    const service = new GithubStatusService(provider)
    service.retain([target])
    service.view(target)
    service.retain([])
    await resolveNext(readyStatus)
    // Key departed: the late result must not resurrect data for it.
    expect(service.view(target).state).toBe('loading')
  })

  test('should mark expired successes stale while refreshing', async () => {
    let calls = 0
    const provider: GithubLike = {
      read: async () => {
        calls += 1
        return readyStatus
      },
    }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    vi.advanceTimersByTime(60_001)
    expect(service.view(target).state).toBe('stale')
    await vi.waitFor(() => expect(service.view(target).state).toBe('ready'))
    expect(calls).toBe(2)
  })

  const conclusiveNegative: GithubStatus = {
    state: 'ready',
    pr: null,
    ci: {
      state: 'unknown',
      commitOid: HEAD,
      complete: false,
      counts: { passing: 0, failing: 0, pending: 0, neutral: 0, unknown: 0 },
      checks: [],
    },
    observedAt: 1000,
    attemptedAt: 1000,
    error: 'commit not found on GitHub',
  }

  test('should hold a conclusive negative for the extended window without refetching', async () => {
    let calls = 0
    const provider: GithubLike = {
      read: async () => {
        calls += 1
        return conclusiveNegative
      },
    }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    expect(calls).toBe(1)
    // Past the 60 s success TTL but inside the conclusive window: still fresh,
    // no background refetch.
    vi.advanceTimersByTime(60_001)
    expect(service.view(target).state).toBe('ready')
    await vi.waitFor(() => expect(calls).toBe(1))
    // Past 5 minutes: re-check.
    vi.advanceTimersByTime(240_000)
    expect(service.view(target).state).toBe('stale')
    await vi.waitFor(() => expect(calls).toBe(2))
  })

  test('should progressively back off repeated no-PR results and reset when a PR appears', async () => {
    let result = conclusiveNegative
    const provider = { read: vi.fn(async () => result) }
    const service = new GithubStatusService(provider)
    await service.fresh(target)

    for (const delay of [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000]) {
      const calls = provider.read.mock.calls.length
      vi.advanceTimersByTime(delay - 1)
      expect(service.view(target).state).toBe('ready')
      expect(provider.read).toHaveBeenCalledTimes(calls)
      vi.advanceTimersByTime(2)
      expect(service.view(target).state).toBe('stale')
      expect(provider.read).toHaveBeenCalledTimes(calls + 1)
      await service.fresh(target)
    }

    result = readyStatus
    await service.fresh(target)
    vi.advanceTimersByTime(60_001)
    result = conclusiveNegative
    expect(service.view(target).state).toBe('stale')
    await service.fresh(target)
    vi.advanceTimersByTime(300_001)
    expect(service.view(target).state).toBe('stale')
  })

  test('should progressively back off failures up to the cap and reset after recovery', async () => {
    let result = unavailableStatus('rate limited')
    const provider = { read: vi.fn(async () => result) }
    const service = new GithubStatusService(provider)
    await service.fresh(target)

    for (const delay of [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const calls = provider.read.mock.calls.length
      vi.advanceTimersByTime(delay - 1)
      expect(service.view(target).state).toBe('unavailable')
      expect(provider.read).toHaveBeenCalledTimes(calls)
      vi.advanceTimersByTime(1)
      service.view(target)
      expect(provider.read).toHaveBeenCalledTimes(calls + 1)
      await service.fresh(target)
    }

    result = readyStatus
    await service.fresh(target)
    result = unavailableStatus('rate limited again')
    await service.fresh(target)
    const calls = provider.read.mock.calls.length
    vi.advanceTimersByTime(15_000)
    expect(service.view(target).state).toBe('stale')
    expect(provider.read).toHaveBeenCalledTimes(calls + 1)
  })

  test('should retry partial CI failures without treating them as conclusive no-PR results', async () => {
    const partial = { ...conclusiveNegative, pr: readyStatus.pr, error: 'rate limited', ciLookup: 'retry' as const }
    const read = vi.fn<GithubLike['read']>().mockResolvedValue(partial).mockResolvedValueOnce({ ...readyStatus, pr: null })
    const provider = { read }
    const service = new GithubStatusService(provider)

    await service.fresh(target)
    expect(await service.fresh(target)).toEqual({ ...conclusiveNegative, pr: partial.pr, error: partial.error })
    expect(service.view(target)).toMatchObject({ state: 'stale', pr: partial.pr, ci: readyStatus.ci, error: partial.error })
    expect(provider.read).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(15_000)
    service.view(target)
    expect(provider.read).toHaveBeenCalledTimes(3)
  })

  test('should use the normal interval when the CI pagination limit is reached', async () => {
    const service = new GithubStatusService({
      read: async () => ({ ...conclusiveNegative, error: 'CI pagination exhausted', ciLookup: 'bounded' }),
    })
    await service.fresh(target)
    vi.advanceTimersByTime(15_000)
    expect(service.view(target).state).toBe('ready')
    vi.advanceTimersByTime(45_000)
    expect(service.view(target).state).toBe('stale')
  })

  test('should skip a queued refresh when sweep already refreshed its key', async () => {
    const blocked = Promise.withResolvers<GithubStatus>()
    const provider = { read: vi.fn((request: GithubRequest) => request.branch === target.branch
      ? Promise.resolve(conclusiveNegative)
      : blocked.promise) }
    const service = new GithubStatusService(provider)
    for (const branch of ['feat/a', 'feat/b', 'feat/c', 'feat/d']) {
      service.view({ ...target, branch })
    }
    service.view(target)
    const unverified = { ...target, headOid: 'b'.repeat(40) }
    service.view(unverified)
    service.view(unverified, false)
    expect(provider.read).toHaveBeenCalledTimes(4)
    await service.fresh(target)
    blocked.resolve(readyStatus)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.read).toHaveBeenCalledTimes(5)
    vi.advanceTimersByTime(300_000)
    expect(service.view(target).state).toBe('stale')
    expect(provider.read).toHaveBeenCalledTimes(6)
  })

  test('should keep the short TTL when a PR exists', async () => {
    const provider: GithubLike = { read: async () => readyStatus }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    vi.advanceTimersByTime(60_001)
    expect(service.view(target).state).toBe('stale')
  })

  test.each(['pending', 'failing'] as const)('should keep the short TTL with pending checks and a %s rollup', async (state) => {
    const pendingCi: GithubStatus = {
      ...conclusiveNegative,
      ci: {
        state,
        commitOid: HEAD,
        complete: false,
        counts: { passing: 0, failing: state === 'failing' ? 1 : 0, pending: 2, neutral: 0, unknown: 0 },
        checks: [],
      },
      error: null,
    }
    const provider: GithubLike = { read: async () => pendingCi }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    vi.advanceTimersByTime(60_001)
    expect(service.view(target).state).toBe('stale')
  })
})
