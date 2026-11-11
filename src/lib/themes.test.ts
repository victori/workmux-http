// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEMES, THEME_IDS, applyTheme, isThemeId, loadThemeId } from './themes'
import type { ThemeId, ThemeTokens } from './themes'

const TOKEN_NAMES = Object.keys(THEMES.night.tokens) as (keyof ThemeTokens)[]
const HEX = /^#[0-9a-f]{6}$/

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff)
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.documentElement.removeAttribute('style')
})

describe('theme registry', () => {
  it('defines every token with a valid hex color in every theme', () => {
    for (const id of THEME_IDS) {
      const t = THEMES[id]
      expect(t.id).toBe(id)
      for (const name of TOKEN_NAMES) {
        expect(t.tokens[name], `${id}.${name}`).toMatch(HEX)
      }
    }
  })

  it('keeps the semantic aliases aligned with their base tokens', () => {
    for (const id of THEME_IDS) {
      const { tokens: t } = THEMES[id]
      expect(t.working).toBe(t.accent)
      expect(t.waiting).toBe(t.warn)
      expect(t.done).toBe(t.ok)
      expect(t.stale).toBe(t.fgMuted)
    }
  })

  it('carries a complete xterm palette per theme', () => {
    for (const id of THEME_IDS) {
      const x = THEMES[id].xterm
      expect(x.ansi).toHaveLength(16)
      expect(x.ansi.every((c) => HEX.test(c))).toBe(true)
      expect(x.background).toBe(THEMES[id].tokens.bg)
      expect(x.foreground).toBe(THEMES[id].tokens.fg)
    }
  })

  it('keeps night identical to the built-in defaults', () => {
    expect(THEMES.night.tokens.bg).toBe('#0b0f14')
    expect(THEMES.night.tokens.accent).toBe('#4cc2ff')
    expect(DEFAULT_THEME).toBe('night')
  })

  it('recognizes only known ids', () => {
    expect(isThemeId('gruvbox')).toBe(true)
    expect(isThemeId('dracula')).toBe(true)
    expect(isThemeId('monokai')).toBe(false)
    expect(isThemeId(null)).toBe(false)
  })

  it('keeps every *-light id in light mode and the rest dark', () => {
    for (const id of THEME_IDS) {
      const expected = id.endsWith('-light') ? 'light' : 'dark'
      expect(THEMES[id].mode, id).toBe(expected)
    }
    expect(THEME_IDS.filter((id) => THEMES[id].mode === 'light').length).toBeGreaterThanOrEqual(5)
    expect(THEME_IDS.filter((id) => THEMES[id].mode === 'dark').length).toBeGreaterThanOrEqual(5)
  })

  it('keeps light themes readable: dark text on light backgrounds', () => {
    for (const id of THEME_IDS.filter((t) => THEMES[t].mode === 'light')) {
      const { bg, fg, fgMuted, surface } = THEMES[id].tokens
      expect(luminance(bg), `${id}.bg`).toBeGreaterThan(0.5)
      expect(contrast(fg, bg), `${id}.fg/bg`).toBeGreaterThanOrEqual(7)
      expect(contrast(fgMuted, bg), `${id}.fgMuted/bg`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(fg, surface), `${id}.fg/surface`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps dark themes readable: light text on dark backgrounds', () => {
    for (const id of THEME_IDS.filter((t) => THEMES[t].mode === 'dark')) {
      const { bg, fg, fgMuted, surface } = THEMES[id].tokens
      expect(luminance(bg), `${id}.bg`).toBeLessThan(0.5)
      expect(contrast(fg, bg), `${id}.fg/bg`).toBeGreaterThanOrEqual(7)
      expect(contrast(fgMuted, bg), `${id}.fgMuted/bg`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(fg, surface), `${id}.fg/surface`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('applyTheme', () => {
  it('sets data-theme, all css variables, and the chrome tint', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#0b0f14">')
    applyTheme('gruvbox')
    expect(document.documentElement.dataset.theme).toBe('gruvbox')
    expect(document.documentElement.style.getPropertyValue('--color-bg')).toBe('#282828')
    expect(document.documentElement.style.getPropertyValue('--color-surface-2')).toBe('#3c3836')
    expect(document.documentElement.style.getPropertyValue('--color-fg-muted')).toBe('#a89984')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#282828')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    applyTheme('github-light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--color-bg')).toBe('#ffffff')
  })
})

describe('loadThemeId', () => {
  it('falls back to night for missing or unknown stored values', () => {
    expect(loadThemeId()).toBe('night')
    localStorage.setItem('wmhttp:theme', JSON.stringify('twilight'))
    expect(loadThemeId()).toBe('twilight')
    localStorage.setItem('wmhttp:theme', JSON.stringify('nonsense'))
    expect(loadThemeId()).toBe('night')
  })
})
