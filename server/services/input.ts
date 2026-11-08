import type { DeliveryResult, KeyName } from '../../shared/types.js'
import type { AppConfig } from '../config.js'
import { BOUNDS } from '../config.js'
import type { TmuxLike } from '../adapters/tmux.js'
import { TMUX_KEYS } from '../adapters/tmux.js'
import type { Discovery } from './discovery.js'

export class TargetGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetGoneError'
  }
}

export class UnknownDeliveryError extends Error {
  readonly requestId: string
  readonly paneId: string
  constructor(requestId: string, paneId: string, message: string) {
    super(message)
    this.name = 'UnknownDeliveryError'
    this.requestId = requestId
    this.paneId = paneId
  }
}

interface DedupEntry {
  at: number
  promise: Promise<DeliveryResult>
}

/**
 * Delivers literal messages and explicit keys to existing managed agent panes.
 * Web submissions are serialized per pane; desktop input stays concurrent.
 * Deduplication covers the service lifetime only; ambiguous failures report
 * unknown delivery and never auto-retry.
 */
export class InputService {
  private queues = new Map<string, Promise<unknown>>()
  private seen = new Map<string, DedupEntry>()

  constructor(
    private readonly cfg: AppConfig,
    private readonly tmux: TmuxLike,
    private readonly discovery: Discovery,
  ) {}

  async message(paneId: string, text: string, requestId: string): Promise<DeliveryResult> {
    return this.dedup(paneId, requestId, () =>
      this.enqueue(paneId, async () => {
        await this.revalidate(paneId)
        if (this.cfg.fixtureDir) {
          return { delivered: 'sent', requestId, paneId, detail: 'fixture' } as DeliveryResult
        }
        try {
          await this.tmux.sendLiteral(paneId, text)
          await this.tmux.sendKeys(paneId, ['Enter'])
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/pane can not be found|no such pane|invalid target/.test(msg)) {
            throw new TargetGoneError(msg)
          }
          throw new UnknownDeliveryError(requestId, paneId, msg)
        }
        return { delivered: 'sent', requestId, paneId } satisfies DeliveryResult
      }),
    )
  }

  async keys(paneId: string, keys: KeyName[], requestId: string): Promise<DeliveryResult> {
    const mapped = keys.map((k) => TMUX_KEYS[k])
    return this.dedup(paneId, requestId, () =>
      this.enqueue(paneId, async () => {
        await this.revalidate(paneId)
        if (this.cfg.fixtureDir) {
          return { delivered: 'sent', requestId, paneId, detail: 'fixture' } as DeliveryResult
        }
        try {
          await this.tmux.sendKeys(paneId, mapped)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/pane can not be found|no such pane|invalid target/.test(msg)) {
            throw new TargetGoneError(msg)
          }
          throw new UnknownDeliveryError(requestId, paneId, msg)
        }
        return {
          delivered: 'sent',
          requestId,
          paneId,
          detail: mapped.join('+'),
        } satisfies DeliveryResult
      }),
    )
  }

  private async revalidate(paneId: string): Promise<void> {
    const targets = await this.discovery.agentTargets()
    if (!targets.has(paneId)) {
      throw new TargetGoneError(`pane ${paneId} is not a managed agent target`)
    }
    if (this.cfg.fixtureDir) return
    if (!(await this.tmux.paneExists(paneId))) {
      throw new TargetGoneError(`pane ${paneId} no longer exists`)
    }
  }

  private enqueue<T>(paneId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(paneId) ?? Promise.resolve()
    const next = prev.then(job, job)
    this.queues.set(
      paneId,
      next.catch(() => undefined),
    )
    return next
  }

  /** Keyed by pane+request so a requestId can never suppress delivery to a different pane. */
  private dedup(
    paneId: string,
    requestId: string,
    run: () => Promise<DeliveryResult>,
  ): Promise<DeliveryResult> {
    const key = `${paneId}\u0000${requestId}`
    const hit = this.seen.get(key)
    if (hit) {
      if (Date.now() - hit.at <= BOUNDS.dedupTtlMs) {
        return hit.promise.then((r) => ({ ...r, paneId, detail: 'duplicate_request' }))
      }
      this.seen.delete(key)
    }
    const promise = run()
    this.seen.set(key, { at: Date.now(), promise })
    if (this.seen.size > BOUNDS.dedupMaxEntries) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) this.seen.delete(oldest[0])
    }
    return promise
  }
}
