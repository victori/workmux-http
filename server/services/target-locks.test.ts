import { describe, expect, test } from 'vitest'
import { Operations } from './operations.js'
import { TargetLocks } from './target-locks.js'

function deferred() {
  return Promise.withResolvers<void>()
}

describe('TargetLocks', () => {
  test('should hold a worktree lock until its returned operation settles', async () => {
    const ops = new Operations()
    const locks = new TargetLocks(ops)
    const gate = deferred()
    const order: string[] = []
    let opId = ''

    const first = locks.run('wt_1', async () => {
      order.push('job1')
      const view = ops.start('push', 'wt_1', async () => {
        await gate.promise
        return { output: 'pushed' }
      })
      opId = view.id
      return view
    })
    await first
    // The operation is still running, so the lock must still be held.
    const second = locks.run('wt_1', async () => {
      order.push('job2')
      return 'row'
    })
    await Promise.resolve()
    expect(order).toEqual(['job1'])

    gate.resolve()
    await ops.settled(opId)
    await second
    expect(order).toEqual(['job1', 'job2'])
  })

  test('should serialize a sweep callback behind a management operation', async () => {
    const ops = new Operations()
    const locks = new TargetLocks(ops)
    const gate = deferred()
    const mgmtView = await locks.run('wt_9', async () =>
      ops.start('merge', 'wt_9', async () => {
        await gate.promise
        return { output: 'merged' }
      }),
    )

    let sweepEntered = false
    const sweep = locks.run('wt_9', async () => {
      sweepEntered = true
      // Sweep callbacks return rows, never the parent operation id.
      return { worktreeId: 'wt_9', state: 'removed' as const, message: null }
    })
    await Promise.resolve()
    expect(sweepEntered).toBe(false)

    gate.resolve()
    await ops.settled(mgmtView.id)
    await sweep
    expect(sweepEntered).toBe(true)
  })

  test('should release the lock when a job rejects', async () => {
    const ops = new Operations()
    const locks = new TargetLocks(ops)
    await expect(locks.run('wt_2', async () => {
      throw new Error('nope')
    })).rejects.toThrow('nope')
    const after = await locks.run('wt_2', async () => 'ok')
    expect(after).toBe('ok')
  })

  test('should keep distinct targets independent', async () => {
    const ops = new Operations()
    const locks = new TargetLocks(ops)
    const gate = deferred()
    const held = locks.run('wt_a', async () => {
      const view = ops.start('close', 'wt_a', async () => {
        await gate.promise
        return { output: 'closed' }
      })
      return view
    })
    await held
    let otherEntered = false
    const other = locks.run('wt_b', async () => {
      otherEntered = true
      return 1
    })
    await other
    expect(otherEntered).toBe(true)
    gate.resolve()
  })
})
