// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEMES, THEME_IDS, applyTheme, isThemeId, loadThemeId } from './themes'
import type { ThemeId, ThemeTokens } from './themes'

const TOKEN_NAMES = Object.keys(THEMES.night.tokens) as (keyof ThemeTokens)[]
const HEX = /^#[0-9a-f]{6}$/

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
    expect(isThemeId('dracula')).toBe(false)
    expect(isThemeId(null)).toBe(false)
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
