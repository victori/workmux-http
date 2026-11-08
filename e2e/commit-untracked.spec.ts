import { expect, test } from '@playwright/test'

const MUTATION = { headers: { 'x-workmux-request': '1', 'content-type': 'application/json' } }

/**
 * Pending-changes + configurable commit on the fixture server (paths from
 * the fixtures do not exist on this host, so git degrades; the e2e contract
 * is validation + graceful failure, behavior is proven by unit/integration).
 * The fixture server runs with WORKMUX_CLAUDE_COMMIT_CMD=/usr/bin/true.
 */

test.describe('pending changes and commit (fixture mode)', () => {
  let wtId = ''

  test('diff response carries the new pending fields and resolves commitCmd', async ({ request }) => {
    const dash = await (await request.get('/api/dashboard')).json()
    wtId = dash.worktrees.find((w: { handle: string }) => w.handle === 'feat-timezone').id
    const diff = await (await request.get(`/api/worktrees/${encodeURIComponent(wtId)}/diff?mode=wip`)).json()
    expect(Array.isArray(diff.untracked)).toBe(true)
    expect(Array.isArray(diff.unstaged)).toBe(true)
    expect(Array.isArray(diff.conflicts)).toBe(true)
    expect(Array.isArray(diff.staged)).toBe(true)
    expect(typeof diff.hasStaged).toBe('boolean')
    expect(diff.commitCmd).toBe('/usr/bin/true') // claude-kind agents in fixtures
  })

  test('add rejects malformed and empty path lists', async ({ request }) => {
    const dash = await (await request.get('/api/dashboard')).json()
    const id = dash.worktrees.find((w: { handle: string }) => w.handle === 'feat-timezone').id
    const bad = await request.post(`/api/worktrees/${encodeURIComponent(id)}/add`, {
      ...MUTATION,
      data: { paths: ['--force'] },
    })
    expect(bad.status()).toBe(200) // malformed is a per-path rejection, not a request error
    expect(await bad.json()).toMatchObject({ ok: false, offenders: ['--force'] })

    const empty = await request.post(`/api/worktrees/${encodeURIComponent(id)}/add`, {
      ...MUTATION,
      data: { paths: [] },
    })
    expect(empty.status()).toBe(400)
  })

  test('unstage rejects malformed and empty path lists', async ({ request }) => {
    const dash = await (await request.get('/api/dashboard')).json()
    const id = dash.worktrees.find((w: { handle: string }) => w.handle === 'feat-timezone').id
    const bad = await request.post(`/api/worktrees/${encodeURIComponent(id)}/unstage`, {
      ...MUTATION,
      data: { paths: ['../escape'] },
    })
    expect(bad.status()).toBe(200)
    expect(await bad.json()).toMatchObject({ ok: false, offenders: ['../escape'] })

    const empty = await request.post(`/api/worktrees/${encodeURIComponent(id)}/unstage`, {
      ...MUTATION,
      data: { paths: [] },
    })
    expect(empty.status()).toBe(400)
  })

  test('commits endpoint degrades gracefully and validates sha', async ({ request }) => {
    const dash = await (await request.get('/api/dashboard')).json()
    const id = dash.worktrees.find((w: { handle: string }) => w.handle === 'feat-timezone').id
    // fixture paths are not real repos -> git log fails -> empty list, not an error
    const res = await request.get(`/api/worktrees/${encodeURIComponent(id)}/commits`)
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ commits: [], truncated: false })

    const noSha = await request.get(`/api/worktrees/${encodeURIComponent(id)}/diff?mode=commit`)
    expect(noSha.status()).toBe(400)
    const range = await request.get(`/api/worktrees/${encodeURIComponent(id)}/diff?mode=commit&sha=main..HEAD`)
    expect(range.status()).toBe(400)
  })

  test('commit accepts an empty message', async ({ request }) => {
    const dash = await (await request.get('/api/dashboard')).json()
    const id = dash.worktrees.find((w: { handle: string }) => w.handle === 'feat-timezone').id
    const res = await request.post(`/api/worktrees/${encodeURIComponent(id)}/commit`, {
      ...MUTATION,
      data: { message: '   ' },
    })
    expect(res.status()).toBe(202)
    expect((await res.json()).operationId).toBeTruthy()
  })

  test('diff view shows CommitBar for claude worktrees and fails gracefully', async ({ page }) => {
    await page.goto('/')
    await page
      .getByRole('tab', { name: /worktrees/i })
      .or(page.getByRole('button', { name: /worktrees/i }))
      .first()
      .click()
    const card = page
      .locator('li,div')
      .filter({ hasText: 'feat-timezone' })
      .filter({ has: page.getByRole('button', { name: 'Diff' }) })
      .last()
    await card.getByRole('button', { name: 'Diff' }).click()
    // Fixture paths don't exist: no pending section, no crash.
    await expect(page.getByRole('region', { name: 'Pending changes' })).toHaveCount(0)
    const input = page.getByRole('textbox', { name: 'Commit message' })
    await expect(input).toBeVisible()
    await input.fill('e2e graceful commit')
    await page.getByRole('button', { name: 'Commit now' }).click()
    // /usr/bin/true cannot spawn in the nonexistent fixture cwd → surfaced error.
    await expect(page.getByText(/commit failed|ENOENT|no such file/i)).toBeVisible({ timeout: 10_000 })
  })
})
