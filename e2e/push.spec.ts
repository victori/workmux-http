import { expect, test } from '@playwright/test'

const MUTATION = { headers: { 'x-workmux-request': '1', 'content-type': 'application/json' } }

/**
 * Push surfaces in fixture mode: discovery git is unavailable there, so
 * badges must NOT be fabricated, and the server-side push evaluation
 * (blocked path) is what the contract covers. Real push behavior is
 * proven by integration tests against a local bare remote.
 */
test.describe('push button (fixture mode)', () => {
  test('dashboard fabricates no unpushed badges without git info', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('↑')).toHaveCount(0)
  })

  test('prepare push on a fixture worktree returns a structured blocked response', async ({ request }) => {
    const dash = await (await request.get('/api/dashboard')).json()
    const id = dash.worktrees[0].id
    const res = await request.post('/api/actions/prepare', {
      ...MUTATION,
      data: { action: 'push', targetId: id },
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.action).toBe('push')
    expect(body.blocked).toMatch(/no commits|no origin/)
  })

  test('prepare push rejects unknown worktrees', async ({ request }) => {
    const res = await request.post('/api/actions/prepare', {
      ...MUTATION,
      data: { action: 'push', targetId: 'wt_deadbeef0000' },
    })
    expect(res.status()).toBe(404)
  })

  test('execute push is routed and rejects invalid confirmation tokens', async ({ request }) => {
    const res = await request.post('/api/actions/execute', {
      ...MUTATION,
      data: {
        action: 'push',
        targetId: 'wt_263bc0066148',
        acceptWarnings: true,
        confirmToken: 'not-a-real-token',
        requestId: 'e2e-push-1',
      },
    })
    expect(res.status()).toBe(409)
    expect((await res.json()).error).toBe('confirmation_required')
  })
})
