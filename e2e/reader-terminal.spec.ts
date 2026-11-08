import { expect, test } from '@playwright/test'

/**
 * Reader/Terminal modes on the agent detail screen (fixture mode).
 * The advanced terminal refuses real PTYs in fixture mode, so the happy
 * transport path uses a mocked WebSocket via routeWebSocket.
 */

test.describe('agent reader/terminal modes (fixture mode)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByText('feat-timezone').first().click()
  })

  test('should open agents in reader mode with an explicit mode control', async ({ page }) => {
    const group = page.getByRole('group', { name: 'Agent view mode' })
    await expect(group.getByRole('button', { name: 'Reader' })).toHaveAttribute('aria-pressed', 'true')
    await expect(group.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('[data-terminal-root]')).toHaveCount(0)
    await expect(page.locator('.terminal-output')).toBeVisible()
  })

  test('should refuse the terminal gracefully in fixture mode and return to reader', async ({ page }) => {
    await page.getByRole('button', { name: 'Terminal' }).click()
    await expect(page.locator('[data-terminal-root]')).toBeVisible()
    await expect(page.getByText(/unavailable in fixture mode/)).toBeVisible()
    await page.getByRole('button', { name: 'Return to Reader' }).first().click()
    await expect(page.locator('[data-terminal-root]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reader' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.terminal-output')).toBeVisible()
  })

  test('should keep the draft and reader state across a mode round-trip', async ({ page }) => {
    const composer = page.getByPlaceholder(/message|prompt|type/i)
    await composer.fill('draft survives modes')
    await page.getByRole('button', { name: 'Terminal' }).click()
    await expect(page.locator('[data-terminal-root]')).toBeVisible()
    // Escape belongs to the PTY while the terminal has focus (vim etc.);
    // the ✕ control is the documented way back to Reader.
    await page.getByRole('button', { name: 'Return to Reader' }).first().click()
    await expect(page.locator('[data-terminal-root]')).toHaveCount(0)
    await expect(composer).toHaveValue('draft survives modes')
  })

  test('should persist the text-size preset across reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Increase text size' }).click()
    await expect(page.locator('.terminal-output')).toHaveCSS('font-size', '14px')
    await page.reload()
    await page.getByText('feat-timezone').first().click()
    await expect(page.locator('.terminal-output')).toHaveCSS('font-size', '14px')
  })

  test('should toggle wrapping without overflowing the page', async ({ page }) => {
    await expect(page.locator('.terminal-output')).toBeVisible()
    await page.getByRole('button', { name: /Wrap lines on/i }).click()
    await expect(page.locator('.terminal-output.no-wrap')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('terminal transport (mocked websocket)', () => {
  test('should attach at server size and resize only after explicit confirm', async ({ page }) => {
    const received: string[] = []
    await page.routeWebSocket('/api/terminal', (ws) => {
      ws.onMessage((raw) => {
        const msg = JSON.parse(raw as string) as { type: string; cols?: number; rows?: number }
        received.push(msg.type)
        if (msg.type === 'attach') {
          ws.send(JSON.stringify({ type: 'attached', agentId: msg.agentId ?? '%7', sessionId: 'wmhttp-adv-mock', cols: 132, rows: 43 }))
          ws.send(JSON.stringify({ type: 'output', data: 'mock-output-line\r\n' }))
        }
        if (msg.type === 'fit') {
          ws.send(JSON.stringify({ type: 'resized', cols: msg.cols ?? 0, rows: msg.rows ?? 0 }))
        }
      })
    })

    await page.goto('/')
    await page.getByText('feat-timezone').first().click()
    await page.getByRole('button', { name: 'Terminal' }).click()

    // Entry: attach only, sized by the (mock) server; no fit is ever sent.
    await expect(page.getByText(/132×43 · server size/)).toBeVisible()
    await expect(page.getByText('mock-output-line')).toBeVisible()
    expect(received).toContain('attach')
    expect(received).not.toContain('fit')

    // Explicit resize requires confirmation; cancel sends nothing.
    await page.getByRole('button', { name: /Resize shared terminal/ }).click()
    await expect(page.getByRole('alertdialog', { name: 'Resize shared terminal' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(received).not.toContain('fit')

    // Confirm: fit goes out, label updates only after the resized ack.
    await page.waitForTimeout(300) // outlive the client-side fit throttle
    await page.getByRole('button', { name: /Resize shared terminal/ }).click()
    await page.getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Resize for all clients' }).click()
    await expect.poll(() => received.includes('fit'), { timeout: 5000 }).toBe(true)
    await expect(page.getByText(/· resized to fit/)).toBeVisible({ timeout: 5000 })
  })
})
