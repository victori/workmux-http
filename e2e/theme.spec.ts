import { expect, test } from '@playwright/test'

test.describe('theme switching (fixture mode)', () => {
  test('should switch themes via the gear sheet and persist across reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night')
    const bodyBg = (hex: string) =>
      expect(page.locator('body')).toHaveCSS('background-color', hex)
    await bodyBg('rgb(11, 15, 20)')

    await page.getByRole('button', { name: 'Theme' }).click()
    const sheet = page.getByRole('dialog', { name: 'Theme' })
    await expect(sheet.getByRole('radio', { name: /Night/ })).toBeChecked()
    await sheet.getByRole('radio', { name: /Gruvbox/ }).click()

    await bodyBg('rgb(40, 40, 40)')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'gruvbox')
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#282828')

    // Durable across reload, and switchable back.
    await page.reload()
    await bodyBg('rgb(40, 40, 40)')
    await page.getByRole('button', { name: 'Theme' }).click()
    await page
      .getByRole('dialog', { name: 'Theme' })
      .getByRole('radio', { name: /Twilight/ })
      .click()
    await bodyBg('rgb(20, 20, 20)')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'twilight')
  })
})
