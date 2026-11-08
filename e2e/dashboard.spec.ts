import { expect, test } from '@playwright/test'

test.describe('managed dashboard (fixture mode)', () => {
  test('should list managed agents with status labels and open worktrees tab', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('sample-app-alpha').first()).toBeVisible()
    await expect(page.getByText('feat-timezone').first()).toBeVisible()
    await expect(page.getByText('Waiting', { exact: false }).first()).toBeVisible()

    await page.getByRole('tab', { name: /worktrees/i }).or(page.getByRole('button', { name: /worktrees/i })).first().click()
    await expect(page.getByText('fix-jobs').first()).toBeVisible()
  })

  test('should filter agents by search text', async ({ page }) => {
    await page.goto('/')
    const search = page.getByPlaceholder(/search/i)
    await search.fill('beta')
    await expect(page.getByText('sample-app-beta').first()).toBeVisible()
    await expect(page.getByText('feat-timezone')).toHaveCount(0)
  })

  test('should show tmux sessions in sessions tab', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /sessions/i }).first().click()
    await expect(page.getByText('shellfish-1').first()).toBeVisible()
    await expect(page.getByText('shellfish-2').first()).toBeVisible()
  })

  test('should open agent output and send a message', async ({ page }) => {
    await page.goto('/')
    await page.getByText('feat-timezone').first().click()
    await expect(page.getByText('DST conversion').first()).toBeVisible()

    const composer = page.getByPlaceholder(/message|prompt|type/i)
    await composer.fill('hello from e2e')
    await page.getByRole('button', { name: /^send$/i }).click()
    await expect(page.getByText('hello from e2e')).toBeVisible()
  })

  test('should expose fixture-mode health', async ({ request }) => {
    const health = await (await request.get('/api/health')).json()
    expect(health.fixtureMode).toBe(true)
    expect(health.ok).toBe(true)
  })
})
