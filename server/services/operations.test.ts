import { describe, expect, test } from 'vitest'
import { Operations } from './operations.js'

describe('Operations structured results', () => {
  test('should preserve unknown outcomes without converting them to failed', async () => {
    const ops = new Operations()
    const view = ops.start('sweep', 'wt_1', async () => ({
      output: 'partial',
      error: 'delivery unknown for one target',
      state: 'unknown' as const,
    }))
    await ops.settled(view.id)
    const final = ops.get(view.id)
    expect(final?.state).toBe('unknown')
    expect(final?.error).toBe('delivery unknown for one target')
    expect(final?.output).toBe('partial')
  })

  test('should publish per-item progress before settlement', async () => {
    const ops = new Operations()
    const gate = Promise.withResolvers<void>()
    const items = [
      { worktreeId: 'wt_1', targetLabel: 'p/a', state: 'removed' as const, message: null },
      { worktreeId: 'wt_2', targetLabel: 'p/b', state: 'pending' as const, message: null },
    ]
    const view = ops.start('sweep', 'scan', async (report) => {
      report({ type: 'sweep', items })
      await gate.promise
      items.push({ worktreeId: 'wt_3', targetLabel: 'p/c', state: 'removed' as const, message: null })
      return { output: 'done' }
    })
    // Progress is visible while the operation still runs.
    expect(ops.get(view.id)?.state).toBe('running')
    const progress = ops.get(view.id)?.result
    expect(progress?.type).toBe('sweep')
    if (progress?.type === 'sweep') expect(progress.items.map((i) => i.worktreeId)).toEqual(['wt_1', 'wt_2'])
    // The reported snapshot must not alias the service's mutable array.
    gate.resolve()
    await ops.settled(view.id)
    const final = ops.get(view.id)?.result
    if (final?.type === 'sweep') expect(final.items.map((i) => i.worktreeId)).toEqual(['wt_1', 'wt_2'])
  })

  test('should default terminal state from error like before', async () => {
    const ops = new Operations()
    const ok = ops.start('push', 'wt_ok', async () => ({ output: 'pushed' }))
    const bad = ops.start('push', 'wt_bad', async () => ({ output: null, error: 'denied' }))
    const boom = ops.start('push', 'wt_boom', async () => {
      throw new Error('crash')
    })
    await Promise.all([ops.settled(ok.id), ops.settled(bad.id), ops.settled(boom.id)])
    expect(ops.get(ok.id)?.state).toBe('done')
    expect(ops.get(bad.id)?.state).toBe('failed')
    expect(ops.get(boom.id)?.state).toBe('failed')
    expect(ops.get(boom.id)?.error).toBe('crash')
  })
})
