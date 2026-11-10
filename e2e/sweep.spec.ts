import { expect, test, type Page } from '@playwright/test'

/**
 * Clean sweep flow on fixture data with ALL sweep mutations intercepted:
 * the fixture server would refuse them (400), and no test may reach a real
 * removal path. Verifies scan -> select -> review -> confirm -> mixed
 * results, honest 202 handling, stale rejection, and resume of a retained
 * operation id.
 */

const SCAN_ID = 'e2e-scan-1'
const SWEEP_ID = 'e2e-sweep-1'

const candidates = [
  {
    worktreeId: 'wt_b456a632633f',
    targetLabel: 'alpha/feat-timezone',
    branch: 'feat/timezone',
    path: '/srv/alpha/.claude/worktrees/feat-timezone',
    reason: 'pr_merged',
    blockers: [],
    warnings: [],
  },
  {
    worktreeId: 'wt_6af13e5a1704',
    targetLabel: 'beta/fix-jobs',
    branch: 'fix/jobs',
    path: '/srv/beta/.claude/worktrees/fix-jobs',
    reason: 'pr_merged',
    blockers: ['worktree has uncommitted changes'],
    warnings: [],
  },
]

const preparedBody = {
  confirmToken: 'a'.repeat(24),
  expiresAt: Date.now() + 300_000,
  targets: [candidates[0]],
  keepBranches: true,
  warnings: ['Removal deletes the worktree directory, including Git-ignored files.'],
}

const sweepDoneBody = {
  id: SWEEP_ID,
  kind: 'sweep',
  target: 'sweep:1',
  state: 'failed',
  output: '1 removed, 0 skipped, 0 failed, 0 unknown',
  error: '1 removed, 0 skipped, 0 failed, 0 unknown',
  result: {
    type: 'sweep',
    items: [
      { worktreeId: 'wt_b456a632633f', targetLabel: 'alpha/feat-timezone', state: 'removed', message: null },
    ],
  },
  startedAt: Date.now(),
  endedAt: Date.now(),
}

function json(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function op(id: string, kind: string, state: string, result?: unknown) {
  return {
    id,
    kind,
    target: `${kind}:1`,
    state,
    output: null,
    error: null,
    result,
    startedAt: Date.now(),
    endedAt: state === 'running' ? null : Date.now(),
  }
}

async function interceptSweep(page: Page) {
  const calls: string[] = []
  await page.route('**/api/sweeps/scan', (route) => {
    calls.push('scan')
    void route.fulfill(json(202, op(SCAN_ID, 'sweep-scan', 'running')))
  })
  await page.route(`**/api/operations/${SCAN_ID}`, (route) => {
    calls.push('op-scan')
    void route.fulfill(json(200, op(SCAN_ID, 'sweep-scan', 'done', { type: 'sweep_scan', candidates, expiresAt: Date.now() + 300_000 })))
  })
  await page.route('**/api/sweeps/prepare', (route) => {
    calls.push('prepare')
    void route.fulfill(json(200, preparedBody))
  })
  await page.route('**/api/sweeps/execute', (route) => {
    calls.push('execute')
    void route.fulfill(json(202, op(SWEEP_ID, 'sweep', 'running')))
  })
  return calls
}

async function openWorktreesTab(page: Page) {
  await page.goto('/')
  await page.getByRole('tab', { name: /worktrees/i }).or(page.getByRole('button', { name: /worktrees/i })).first().click()
}

async function openSweep(page: Page) {
  await openWorktreesTab(page)
  await page.getByRole('button', { name: /clean sweep/i }).click()
}

test.describe('clean sweep (intercepted)', () => {
  test('scan -> select -> review -> confirm shows mixed per-item results', async ({ page }) => {
    const calls = await interceptSweep(page)
    let sweepPolls = 0
    await page.route(`**/api/operations/${SWEEP_ID}`, (route) => {
      sweepPolls += 1
      void route.fulfill(json(200, sweepPolls === 1 ? op(SWEEP_ID, 'sweep', 'running') : sweepDoneBody))
    })

    await openSweep(page)
    await expect(page.getByText('alpha/feat-timezone')).toBeVisible()
    await expect(page.getByText(/uncommitted changes/)).toBeVisible()

    // keyboard selection of the eligible row
    const eligible = page.getByRole('checkbox').first()
    await eligible.focus()
    await page.keyboard.press('Space')
    await expect(eligible).toBeChecked()
    await expect(page.getByRole('checkbox').nth(1)).toBeDisabled()

    // 44px tap targets for the primary controls
    for (const sel of [/select eligible/i, /review selection/i]) {
      const box = await page.getByRole('button', { name: sel }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(44)
    }

    await page.getByRole('button', { name: /review selection/i }).click()
    await expect(page.getByText(/will be removed/i)).toBeVisible()
    await expect(page.getByText(/Git-ignored files/)).toBeVisible()

    await page.getByRole('checkbox', { name: /acknowledge warnings/i }).check()
    await page.getByRole('button', { name: /remove 1 worktrees/i }).click()

    // 202 acceptance is progress, not success
    await expect(page.getByRole('status').getByText(/removing/i)).toBeVisible()
    await expect(page.getByText('Sweep finished')).toHaveCount(0)

    await expect(page.getByRole('status').getByText('removed').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('1 removed, 0 skipped, 0 failed, 0 unknown')).toBeVisible()
    expect(calls).toEqual(expect.arrayContaining(['scan', 'op-scan', 'prepare', 'execute']))
    expect(sweepPolls).toBeGreaterThanOrEqual(2)
  })

  test('stale prepare rejection asks for a rescan and keeps the sheet usable', async ({ page }) => {
    await page.route('**/api/sweeps/scan', (route) => void route.fulfill(json(202, op(SCAN_ID, 'sweep-scan', 'running'))))
    await page.route(`**/api/operations/${SCAN_ID}`, (route) =>
      void route.fulfill(json(200, op(SCAN_ID, 'sweep-scan', 'done', { type: 'sweep_scan', candidates, expiresAt: Date.now() + 300_000 }))),
    )
    await page.route('**/api/sweeps/prepare', (route) =>
      void route.fulfill(json(409, { error: 'snapshot_stale', detail: 'evidence changed since scan' })),
    )
    await openSweep(page)
    await page.getByRole('checkbox').first().check()
    await page.getByRole('button', { name: /review selection/i }).click()
    await expect(page.getByRole('alert').getByText(/snapshot_stale.*rescan/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /review selection/i })).toBeVisible()
  })

  test('resumes a retained sweep operation without rescanning', async ({ page }) => {
    let scanCalls = 0
    await page.route('**/api/sweeps/scan', (route) => {
      scanCalls += 1
      void route.fulfill(json(202, op(SCAN_ID, 'sweep-scan', 'running')))
    })
    let polls = 0
    await page.route(`**/api/operations/${SWEEP_ID}`, (route) => {
      polls += 1
      void route.fulfill(
        json(
          200,
          polls === 1
            ? op(SWEEP_ID, 'sweep', 'running', { type: 'sweep', items: [{ worktreeId: 'wt_b456a632633f', targetLabel: 'alpha/feat-timezone', state: 'running', message: null }] })
            : sweepDoneBody,
        ),
      )
    })
    await page.addInitScript(() => sessionStorage.setItem('wmhttp-tab:sweepOperationId', JSON.stringify('e2e-sweep-1')))
    await openSweep(page)
    await expect(page.getByRole('status').getByText('alpha/feat-timezone')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('status').getByText('removed').first()).toBeVisible({ timeout: 10_000 })
    expect(scanCalls).toBe(0)
    await page.getByRole('button', { name: /^done$/i }).click()
    const stored = await page.evaluate(() => sessionStorage.getItem('wmhttp-tab:sweepOperationId'))
    expect(stored).toBeNull()
  })

  test('fixture server itself refuses sweep mutations (defense in depth)', async ({ page }) => {
    await page.goto('/')
    const res = await page.request.post('/api/sweeps/scan', {
      headers: { 'x-workmux-request': '1', 'content-type': 'application/json' },
      data: { worktreeIds: ['wt_b456a632633f'], requestId: 'e2e-real-1' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).detail).toContain('fixture mode')
  })
})
