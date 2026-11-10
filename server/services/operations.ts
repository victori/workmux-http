import { randomUUID } from 'node:crypto'
import type { OperationResult, OperationView } from '../../shared/types.js'

/**
 * Long-running management actions run server-side; disconnecting the
 * initiating browser never cancels them. Results stay readable after end.
 */
const MAX_FINISHED_OPS = 100

/** Callback outcome: `state` defaults to done/failed from `error`; `result`
 * carries structured payloads (e.g. per-item sweep progress). */
export interface OperationOutcome {
  output: string | null
  error?: string
  result?: OperationResult
  state?: 'done' | 'failed' | 'unknown'
}

function snapshotResult(result: OperationResult): OperationResult {
  return result.type === 'sweep' ? { ...result, items: result.items.map((item) => ({ ...item })) } : { ...result }
}

export class Operations {
  private ops = new Map<string, OperationView>()
  private done = new Map<string, Promise<void>>()

  start(
    kind: string,
    target: string,
    fn: (report: (result: OperationResult) => void) => Promise<OperationOutcome>,
  ): OperationView {
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
    const report = (result: OperationResult): void => {
      view.result = snapshotResult(result)
    }
    const settled = fn(report)
      .then(({ output, error, result, state }) => {
        view.state = state ?? (error ? 'failed' : 'done')
        view.output = output
        view.error = error ?? null
        if (result) view.result = snapshotResult(result)
      })
      .catch((err: unknown) => {
        view.state = 'failed'
        view.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        view.endedAt = Date.now()
        this.done.delete(id)
      })
    this.done.set(id, settled)
    return view
  }

  /** Resolves once the operation reaches a terminal state (immediately if unknown/finished). */
  settled(id: string): Promise<void> {
    return this.done.get(id) ?? Promise.resolve()
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
