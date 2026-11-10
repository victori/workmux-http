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
    const provider: GithubLike = { read: async () => result }
    const service = new GithubStatusService(provider)
    service.retain([target])
    await service.fresh(target)
    expect(service.view(target).state).toBe('ready')

    vi.advanceTimersByTime(60_001)
    result = unavailableStatus('rate limited')
    expect(service.view(target).state).toBe('stale')
    await vi.waitFor(() => expect(service.view(target).pr?.number).toBe(1))
    // Background failure keeps the last-good data, still stale.
    const afterFailure = service.view(target)
    expect(afterFailure.state).toBe('stale')
    expect(afterFailure.pr?.number).toBe(1)
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
})
