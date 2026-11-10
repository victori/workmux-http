import type { Operations } from './operations.js'

/**
 * Per-target serialization shared by Management and Sweep. A job that
 * returns an operation view keeps the lock until that operation settles,
 * not just until the job function returns. Sweep callbacks must return
 * plain rows — returning the parent sweep operation id would deadlock on
 * itself.
 */
export class TargetLocks {
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(private readonly operations: Operations) {}

  run<T>(targetId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(targetId) ?? Promise.resolve()
    const next = previous.then(job, job)
    const held = next
      .then((value) => {
        const operationId = (value as { id?: unknown } | null)?.id
        if (typeof operationId === 'string') return this.operations.settled(operationId)
        return undefined
      })
      .catch(() => undefined)
    this.tails.set(targetId, held)
    void held.finally(() => {
      if (this.tails.get(targetId) === held) this.tails.delete(targetId)
    })
    return next
  }
}
