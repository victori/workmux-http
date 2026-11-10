import { expect, test } from '@playwright/test'

test.describe('managed dashboard (fixture mode)', () => {
  test('should list managed agents with status labels and open worktrees tab', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('sample-app-alpha').first()).toBeVisible()
    // Healthy sources must not claim outdated data, even with idle agents.
    await expect(page.getByText('Data may be outdated')).toHaveCount(0)
    await expect(page.getByText('feat-timezone').first()).toBeVisible()
    await expect(page.getByText('Waiting', { exact: false }).first()).toBeVisible()
    const agentCard = page.getByRole('button', { name: /feat-timezone/ }).filter({ has: page.getByTitle('Agent: claude') })
    await expect(agentCard.getByTitle('Agent: claude')).toBeVisible()

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
    // The pane itself must scroll and land at the tail (latest output).
    const box = page.locator('.terminal-output')
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await expect
      .poll(() => box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThanOrEqual(40)

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
