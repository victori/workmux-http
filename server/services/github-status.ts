import { BOUNDS } from '../config.js'
import type { GithubLike, GithubRequest } from '../adapters/github.js'
import type { GithubStatus } from '../../shared/types.js'

/**
 * Non-blocking GitHub PR/CI status cache (design §3.2).
 *
 * - `view` never awaits the network: it serves cache/last-good data and
 *   schedules background refreshes under a concurrency cap.
 * - Successes serve fresh for `githubSuccessTtlMs`, then stale (last-good
 *   retained indefinitely for the same identity while refreshes fail).
 * - Consecutive no-PR results and failures back off to their respective caps.
 *   A new commit changes the cache key; `fresh` (sweep) bypasses the backoff.
 * - Cache keys include the exact HEAD oid: a prior commit's CI never labels
 *   a new commit. `retain` prunes departed keys and drops late results.
 */

interface OkEntry {
  kind: 'ok'
  refreshAt: number
  delayMs: number
  value: GithubStatus
  /** True for a conclusive negative (no PR, nothing pending) → longer TTL. */
  conclusive: boolean
}

interface FailEntry {
  kind: 'fail'
  at: number
  refreshAt: number
  delayMs: number
  error: string
  lastGood: GithubStatus | null
}

type CacheEntry = OkEntry | FailEntry

/**
 * A completed query that found no PR and has nothing in flight (no pending
 * CI). Such a result is stable until the branch moves or a PR is opened, so
 * it can be served for longer before re-checking GitHub.
 */
export function isConclusiveNegative(v: GithubStatus): boolean {
  return v.state === 'ready' && v.pr === null && v.ci?.state !== 'pending' && !v.ci?.counts.pending
}

function keyOf(request: GithubRequest): string {
  return JSON.stringify([
    request.headRepository,
    request.configuredBaseRepository,
    request.branch,
    request.headOid,
  ])
}

function loading(attemptedAt: number): GithubStatus {
  return { state: 'loading', pr: null, ci: null, observedAt: null, attemptedAt, error: null }
}

export class GithubStatusService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<GithubStatus>>()
  private readonly queue: Array<{ key: string; request: GithubRequest }> = []
  private liveKeys: Set<string> | null = null
  private active = 0

  constructor(private readonly provider: GithubLike) {}

  /** Current view for a request; schedules a background refresh when due. */
  view(request: GithubRequest, scheduleRefresh = true): GithubStatus {
    const key = keyOf(request)
    if (!scheduleRefresh) {
      const queued = this.queue.findIndex((item) => item.key === key)
      if (queued >= 0) this.queue.splice(queued, 1)
    }
    const entry = this.cache.get(key)
    const now = Date.now()
    if (entry?.kind === 'ok') {
      if (now < entry.refreshAt) return entry.value
      if (scheduleRefresh) this.schedule(key, request)
      return { ...entry.value, state: 'stale' }
    }
    if (entry?.kind === 'fail') {
      if (scheduleRefresh && now >= entry.refreshAt) this.schedule(key, request)
      if (entry.lastGood) return { ...entry.lastGood, state: 'stale', error: entry.error, attemptedAt: entry.at }
      return { ...unavailable(entry.error), attemptedAt: entry.at }
    }
    if (scheduleRefresh) this.schedule(key, request)
    return loading(now)
  }

  /**
   * Bypasses completed cache entries and returns a fresh provider result.
   * In-flight reads are shared only for the identical target key.
   */
  fresh(request: GithubRequest): Promise<GithubStatus> {
    return this.execute(keyOf(request), request)
  }

  /** Declares the live identity set; prunes departed keys and blocks their late writes. */
  retain(requests: GithubRequest[]): void {
    const keys = new Set(requests.map(keyOf))
    this.liveKeys = keys
    for (const key of [...this.cache.keys()]) {
      if (!keys.has(key)) this.cache.delete(key)
    }
  }

  private schedule(key: string, request: GithubRequest): void {
    if (this.inflight.has(key)) return
    if (this.active >= BOUNDS.githubConcurrency) {
      if (this.queue.length >= BOUNDS.githubQueueMax) return
      if (!this.queue.some((item) => item.key === key)) this.queue.push({ key, request })
      return
    }
    void this.execute(key, request)
  }

  private execute(key: string, request: GithubRequest): Promise<GithubStatus> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    this.active += 1
    const live = (): boolean => !this.liveKeys || this.liveKeys.has(key)
    const promise = this.provider
      .read(request)
      .then(({ ciLookup, ...value }) => {
        if (live()) {
          if (value.state === 'ready' && ciLookup !== 'retry') {
            const previous = this.cache.get(key)
            const conclusive = ciLookup !== 'bounded' && isConclusiveNegative(value)
            const delayMs = conclusive
              ? previous?.kind === 'ok' && previous.conclusive
                ? Math.min(previous.delayMs * 2, BOUNDS.githubConclusiveTtlMaxMs)
                : BOUNDS.githubConclusiveTtlMs
              : BOUNDS.githubSuccessTtlMs
            this.cache.set(key, { kind: 'ok', refreshAt: Date.now() + delayMs, delayMs, value, conclusive })
          } else {
            this.recordFailure(key, value.error ?? 'GitHub status unavailable', ciLookup === 'retry' ? value : null)
          }
          this.trim()
        }
        return value
      })
      .catch((err: unknown) => {
        if (live()) {
          this.recordFailure(key, String(err))
          this.trim()
        }
        return unavailable(String(err))
      })
      .finally(() => {
        this.active -= 1
        if (this.inflight.get(key) === promise) this.inflight.delete(key)
        this.drain()
      })
    this.inflight.set(key, promise)
    return promise
  }

  private recordFailure(key: string, error: string, partial: GithubStatus | null = null): void {
    const previous = this.cache.get(key)
    const at = Date.now()
    const delayMs = previous?.kind === 'fail'
      ? Math.min(previous.delayMs * 2, BOUNDS.githubFailureRetryMaxMs)
      : BOUNDS.githubFailureRetryMs
    const previousStatus = previous?.kind === 'ok' ? previous.value : previous?.lastGood
    const lastGood = partial && previousStatus?.ci
      ? { ...partial, ci: previousStatus.ci, observedAt: previousStatus.observedAt }
      : partial ?? previousStatus ?? null
    this.cache.set(key, { kind: 'fail', at, refreshAt: at + delayMs, delayMs, error, lastGood })
  }

  private drain(): void {
    while (this.active < BOUNDS.githubConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) break
      if (this.liveKeys && !this.liveKeys.has(next.key)) continue
      if (this.inflight.has(next.key)) continue
      const cached = this.cache.get(next.key)
      if (cached && Date.now() < cached.refreshAt) continue
      void this.execute(next.key, next.request)
    }
  }

  private trim(): void {
    while (this.cache.size > BOUNDS.githubCacheMax) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }
}

function unavailable(error: string): GithubStatus {
  return { state: 'unavailable', pr: null, ci: null, observedAt: null, attemptedAt: Date.now(), error }
}
