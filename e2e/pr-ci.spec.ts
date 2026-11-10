import { expect, test, type Page } from '@playwright/test'

/**
 * PR/CI visibility on fixture data. The fixture server serves
 * fixtures/github-status.json; extra lifecycle states are injected by
 * rewriting /api/dashboard so every badge state is deterministic without
 * touching GitHub.
 */

async function dashboardWithWorktreeGithub(page: Page, handle: string, mutate: (wt: Record<string, unknown>) => void) {
  await page.route('**/api/dashboard', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const wt = (body.worktrees as Array<Record<string, unknown>>).find((w) => w.handle === handle)
    if (wt) mutate(wt)
    await route.fulfill({ response: res, json: body })
  })
}

const pr = (over: Record<string, unknown>) => ({
  number: 55,
  title: 'Injected',
  url: 'https://github.com/acme/widgets/pull/55',
  state: 'open',
  review: 'review_required',
  headOid: 'e'.repeat(40),
  headRepository: 'acme/widgets',
  baseRepository: 'acme/widgets',
  baseBranch: 'main',
  ...over,
})

const ci = (over: Record<string, unknown>) => ({
  state: 'passing',
  commitOid: 'e'.repeat(40),
  complete: true,
  counts: { passing: 2, failing: 0, pending: 0, neutral: 0, unknown: 0 },
  checks: [],
  ...over,
})

const at = () => Date.now()

test.describe('PR/CI status (fixture mode)', () => {
  test('should show open PR with pending CI on the agent card via worktree join', async ({ page }) => {
    await page.goto('/')
    const link = page.getByRole('link', { name: /PR #128/ }).first()
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'https://github.com/acme/sample-app-alpha/pull/128')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link.locator('xpath=ancestor::button')).toHaveCount(0)
    await expect(page.getByText(/CI 2 pending/).first()).toBeVisible()
  })

  test('should surface failing checks with names on the worktrees tab', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: /worktrees/i }).or(page.getByRole('button', { name: /worktrees/i })).first().click()
    await expect(page.getByText('CI 2 failing').first()).toBeVisible()
    await page.getByText(/Checks \(3\)/).first().click()
    await expect(page.getByRole('link', { name: 'integration' })).toBeVisible()
  })

  test('should disclose provider failure without claiming the dashboard is offline', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: /worktrees/i }).or(page.getByRole('button', { name: /worktrees/i })).first().click()
    await expect(page.getByText(/GitHub unavailable/).first()).toBeVisible()
    await expect(page.getByText(/authentication required/).first()).toBeVisible()
    await expect(page.getByText('Data may be outdated')).toHaveCount(0)
  })

  test('should label stale last-good data as outdated', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: /worktrees/i }).or(page.getByRole('button', { name: /worktrees/i })).first().click()
    await expect(page.getByText(/outdated/).first()).toBeVisible()
  })

  for (const [name, status, expectText] of [
    ['draft PR', { state: 'ready', pr: pr({ state: 'draft', review: 'unknown' }), ci: null, observedAt: at(), attemptedAt: at(), error: null }, 'PR #55 · draft'],
    ['closed PR', { state: 'ready', pr: pr({ state: 'closed', review: 'changes_requested' }), ci: null, observedAt: at(), attemptedAt: at(), error: null }, 'changes requested'],
    ['merged PR', { state: 'ready', pr: pr({ state: 'merged', review: 'approved' }), ci: ci(), observedAt: at(), attemptedAt: at(), error: null }, 'PR #55 · merged'],
    ['branch checks without a PR', { state: 'ready', pr: null, ci: ci(), observedAt: at(), attemptedAt: at(), error: null }, 'No PR'],
    ['stale no-PR history', { state: 'stale', pr: null, ci: null, observedAt: at() - 7_200_000, attemptedAt: at(), error: null }, 'Last checked: no PR'],
    ['unsupported provider', { state: 'unsupported', pr: null, ci: null, observedAt: null, attemptedAt: null, error: null }, 'GitHub unsupported'],
    ['unknown checks never read as passing', { state: 'ready', pr: null, ci: ci({ state: 'unknown', complete: false, counts: { passing: 2, failing: 0, pending: 0, neutral: 0, unknown: 1 } }), observedAt: at(), attemptedAt: at(), error: null }, 'CI checks unknown'],
  ] as const) {
    test(`should render ${name}`, async ({ page }) => {
      await dashboardWithWorktreeGithub(page, 'feat-timezone', (wt) => {
        wt.github = status
      })
      await page.goto('/')
      await expect(page.getByText(expectText).first()).toBeVisible()
      if (name === 'unknown checks never read as passing') {
        const card = page.locator('div.rounded-xl').filter({ hasText: 'CI checks unknown' }).first()
        await expect(card).toBeVisible()
        await expect(card.getByText(/CI passing/)).toHaveCount(0)
        await expect(card.getByText('incomplete')).toBeVisible()
      }
    })
  }
})
