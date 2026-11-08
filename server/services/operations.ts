import { randomUUID } from 'node:crypto'
import type { OperationView } from '../../shared/types.js'

/**
 * Long-running management actions run server-side; disconnecting the
 * initiating browser never cancels them. Results stay readable after end.
 */
const MAX_FINISHED_OPS = 100

export class Operations {
  private ops = new Map<string, OperationView>()

  start(kind: string, target: string, fn: () => Promise<{ output: string | null; error?: string }>): OperationView {
    const id = randomUUID()
    const view: OperationView = {
      id,
      kind,
      target,
      state: 'running',
      output: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    }
    this.ops.set(id, view)
    this.evict()
    void fn()
      .then(({ output, error }) => {
        view.state = error ? 'failed' : 'done'
        view.output = output
        view.error = error ?? null
      })
      .catch((err: unknown) => {
        view.state = 'failed'
        view.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        view.endedAt = Date.now()
      })
    return view
  }

  get(id: string): OperationView | null {
    return this.ops.get(id) ?? null
  }

  private evict(): void {
    const finished = [...this.ops.entries()]
      .filter(([, v]) => v.state !== 'running')
      .sort((a, b) => (b[1].endedAt ?? 0) - (a[1].endedAt ?? 0))
    for (const [id] of finished.slice(MAX_FINISHED_OPS)) this.ops.delete(id)
  }

  list(): OperationView[] {
    return [...this.ops.values()].sort((a, b) => b.startedAt - a.startedAt)
  }
}
