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
 * - Failures retry after `githubFailureRetryMs`.
 * - Cache keys include the exact HEAD oid: a prior commit's CI never labels
 *   a new commit. `retain` prunes departed keys and drops late results.
 */

interface OkEntry {
  kind: 'ok'
  at: number
  value: GithubStatus
}

interface FailEntry {
  kind: 'fail'
  at: number
  error: string
}

type CacheEntry = OkEntry | FailEntry

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
  view(request: GithubRequest): GithubStatus {
    const key = keyOf(request)
    const entry = this.cache.get(key)
    const now = Date.now()
    if (entry?.kind === 'ok') {
      if (now - entry.at <= BOUNDS.githubSuccessTtlMs) return entry.value
      this.schedule(key, request)
      return { ...entry.value, state: 'stale' }
    }
    if (entry?.kind === 'fail') {
      if (now - entry.at < BOUNDS.githubFailureRetryMs) {
        return { ...unavailable(entry.error), attemptedAt: entry.at }
      }
      this.schedule(key, request)
      return this.inflight.has(key) ? loading(now) : unavailable(entry.error)
    }
    this.schedule(key, request)
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
      .then((value) => {
        if (live()) {
          if (value.state === 'ready') {
            this.cache.set(key, { kind: 'ok', at: Date.now(), value })
          } else if (this.cache.get(key)?.kind !== 'ok') {
            // Failures never clobber last-good data for the same identity.
            this.cache.set(key, { kind: 'fail', at: Date.now(), error: value.error ?? 'GitHub status unavailable' })
          }
          this.trim()
        }
        return value
      })
      .catch((err: unknown) => {
        if (live() && this.cache.get(key)?.kind !== 'ok') {
          this.cache.set(key, { kind: 'fail', at: Date.now(), error: String(err) })
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

  private drain(): void {
    while (this.active < BOUNDS.githubConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) break
      if (this.liveKeys && !this.liveKeys.has(next.key)) continue
      if (this.inflight.has(next.key)) continue
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
