import { loadPref, savePref } from './storage'

export type ThemeId = 'night' | 'gruvbox' | 'twilight'

export interface ThemeTokens {
  bg: string
  surface: string
  surface2: string
  line: string
  fg: string
  fgMuted: string
  accent: string
  ok: string
  warn: string
  err: string
  working: string
  waiting: string
  done: string
  stale: string
}

export interface XtermPalette {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  ansi: string[]
}

export interface Theme {
  id: ThemeId
  label: string
  tokens: ThemeTokens
  xterm: XtermPalette
}

/** CSS custom property for each token (mirrors the Tailwind @theme names). */
const CSS_VAR: Record<keyof ThemeTokens, string> = {
  bg: '--color-bg',
  surface: '--color-surface',
  surface2: '--color-surface-2',
  line: '--color-line',
  fg: '--color-fg',
  fgMuted: '--color-fg-muted',
  accent: '--color-accent',
  ok: '--color-ok',
  warn: '--color-warn',
  err: '--color-err',
  working: '--color-working',
  waiting: '--color-waiting',
  done: '--color-done',
  stale: '--color-stale',
}

const NIGHT: Theme = {
  id: 'night',
  label: 'Night',
  tokens: {
    bg: '#0b0f14',
    surface: '#131a22',
    surface2: '#1a232e',
    line: '#263241',
    fg: '#dce3ea',
    fgMuted: '#8494a7',
    accent: '#4cc2ff',
    ok: '#3fb950',
    warn: '#d29922',
    err: '#f85149',
    working: '#4cc2ff',
    waiting: '#d29922',
    done: '#3fb950',
    stale: '#8494a7',
  },
  xterm: {
    background: '#0b0f14',
    foreground: '#dce3ea',
    cursor: '#4cc2ff',
    selectionBackground: '#263241',
    ansi: [
      '#0b0f14', '#f85149', '#3fb950', '#d29922', '#4cc2ff', '#bc8cff', '#39c5cf', '#dce3ea',
      '#8494a7', '#ff7b72', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff',
    ],
  },
}

const GRUVBOX: Theme = {
  id: 'gruvbox',
  label: 'Gruvbox',
  tokens: {
    bg: '#282828',
    surface: '#32302f',
    surface2: '#3c3836',
    line: '#504945',
    fg: '#ebdbb2',
    fgMuted: '#a89984',
    accent: '#83a598',
    ok: '#b8bb26',
    warn: '#fabd2d',
    err: '#fb4934',
    working: '#83a598',
    waiting: '#fabd2d',
    done: '#b8bb26',
    stale: '#a89984',
  },
  xterm: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#83a598',
    selectionBackground: '#504945',
    ansi: [
      '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2d', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2',
    ],
  },
}

const TWILIGHT: Theme = {
  id: 'twilight',
  label: 'Twilight',
  tokens: {
    bg: '#141414',
    surface: '#1c1b1a',
    surface2: '#252321',
    line: '#33312e',
    fg: '#f4e9d0',
    fgMuted: '#888375',
    accent: '#7587a6',
    ok: '#8f9d6a',
    warn: '#cda869',
    err: '#cf6a4c',
    working: '#7587a6',
    waiting: '#cda869',
    done: '#8f9d6a',
    stale: '#888375',
  },
  xterm: {
    background: '#141414',
    foreground: '#f4e9d0',
    cursor: '#7587a6',
    selectionBackground: '#33312e',
    ansi: [
      '#141414', '#cf6a4c', '#8f9d6a', '#e9c062', '#7587a6', '#9b859d', '#7f8d96', '#f4e9d0',
      '#6b675e', '#df8d70', '#a8b683', '#f0cf7d', '#8fa3c2', '#b39cb5', '#9fb3bc', '#fefcf0',
    ],
  },
}

export const THEMES: Record<ThemeId, Theme> = {
  night: NIGHT,
  gruvbox: GRUVBOX,
  twilight: TWILIGHT,
}

export const THEME_IDS: ThemeId[] = ['night', 'gruvbox', 'twilight']

export const DEFAULT_THEME: ThemeId = 'night'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEMES
}

/** Apply a theme: CSS custom properties, data-theme hook, iPhone chrome tint. */
export function applyTheme(id: ThemeId): void {
  const theme = THEMES[id]
  const root = document.documentElement
  root.dataset.theme = id
  for (const [token, cssVar] of Object.entries(CSS_VAR) as [keyof ThemeTokens, string][]) {
    root.style.setProperty(cssVar, theme.tokens[token])
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.tokens.bg)
}

/** Durable preference; unknown stored values fall back to the default. */
export function loadThemeId(): ThemeId {
  const stored = loadPref<string>('theme', DEFAULT_THEME)
  return isThemeId(stored) ? stored : DEFAULT_THEME
}

export function saveThemeId(id: ThemeId): void {
  savePref('theme', id)
}
