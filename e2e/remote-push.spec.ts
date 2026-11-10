import { expect, test, type Page } from '@playwright/test'

/**
 * Multi-remote push on fixture data. Badges come from fixtures/remotes.json
 * (served by discovery in fixture mode); the push confirm flow is injected
 * via route rewriting so every picker state is deterministic and no request
 * ever performs a real push.
 */

const remotes = [
  { name: 'origin', url: 'git@gitea.example.com:ai/sample-app-alpha.git', hasRef: true, unpushed: 2, behind: 0, upstream: true },
  { name: 'github', url: 'git@github.com:acme/sample-app-alpha.git', hasRef: false, unpushed: null, behind: null, upstream: false },
]

const prepared = (token: string, remote: string, warnings: string[]) => ({
  action: 'push',
  targetId: 'wt_b456a632633f',
  targetLabel: 'sample-app-alpha/feat-timezone [feat/timezone]',
  requiresConfirmation: true,
  confirmToken: token,
  warnings,
  commits: [
    { sha: 'abc1234', subject: 'fix: second' },
    { sha: 'def5678', subject: 'feat: first' },
  ],
  commitsTruncated: false,
  remotes,
  remote,
  setUpstream: false,
})

async function interceptPush(page: Page) {
  const prepares: Array<Record<string, unknown>> = []
  const executes: Array<Record<string, unknown>> = []
  await page.route('**/api/dashboard', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const agent = (body.agents as Array<Record<string, unknown>>).find((a) => a.name === 'feat-timezone')
    if (agent) {
      agent.git = { branch: 'feat/timezone', hasStaged: false, hasUnstaged: false, hasUnmergedCommits: false, unborn: false, ahead: 2, behind: 0 }
    }
    await route.fulfill({ response: res, json: body })
  })
  await page.route('**/api/actions/prepare', async (route) => {
    const req = route.request().postDataJSON() as Record<string, unknown>
    prepares.push(req)
    const picked = (req.remote as string | undefined) ?? 'origin'
    const token = prepares.length === 1 ? 'tok-e2e-1' : 'tok-e2e-2'
    await route.fulfill({
      status: 200,
      json: prepared(token, picked, picked === 'github' ? ['no github/feat/timezone; this creates it'] : []),
    })
  })
  await page.route('**/api/actions/execute', async (route) => {
    const req = route.request().postDataJSON() as Record<string, unknown>
    executes.push(req)
    await route.fulfill({
      status: 202,
      json: {
        id: 'op-e2e-remote',
        kind: 'push',
        target: 'sample-app-alpha/feat-timezone',
        state: 'running',
        output: null,
        error: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    })
  })
  await page.route('**/api/operations/op-e2e-remote', async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        id: 'op-e2e-remote',
        kind: 'push',
        target: 'sample-app-alpha/feat-timezone',
        state: 'done',
        output: 'abc1234..def5678 feat/timezone -> github/feat/timezone',
        error: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    })
  })
  return { prepares, executes }
}

test.describe('multi-remote push (intercepted)', () => {
  test('should show per-remote badges from fixture remote state', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: /worktrees/i }).or(page.getByRole('button', { name: /worktrees/i })).first().click()
    await expect(page.getByTitle('2 unpushed commits to origin').first()).toBeVisible()
    await expect(page.getByTitle('never pushed to github').first()).toBeVisible()
  })

  test('should re-prepare on remote switch and carry the picked remote into execute', async ({ page }) => {
    const { prepares, executes } = await interceptPush(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'Push feat-timezone' }).click()

    const dialog = page.getByRole('alertdialog', { name: 'Push commits' })
    await expect(dialog).toBeVisible()
    const group = dialog.getByRole('radiogroup', { name: 'Push target remote' })
    await expect(group.getByRole('radio', { name: 'origin' })).toBeChecked()
    await expect(group.getByRole('radio', { name: 'github' })).not.toBeChecked()

    await group.getByRole('radio', { name: 'github' }).click()
    await expect(group.getByRole('radio', { name: 'github' })).toBeChecked()
    await expect(dialog.getByText(/no github\/feat\/timezone; this creates it/)).toBeVisible()
    expect(prepares.length).toBeGreaterThanOrEqual(2)
    expect(prepares[1]?.remote).toBe('github')

    await dialog.getByRole('checkbox', { name: /ready to push/i }).check()
    await dialog.getByRole('button', { name: 'Push now' }).click()
    await expect.poll(() => executes.length).toBe(1)
    expect(executes[0]).toMatchObject({ action: 'push', confirmToken: 'tok-e2e-2', remote: 'github', setUpstream: false })
    await expect(page.getByText(/✓ pushed.*github\/feat\/timezone/).first()).toBeVisible()
  })
})
