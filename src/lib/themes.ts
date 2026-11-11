import { loadPref, savePref } from './storage'

export type ThemeId =
  | 'night'
  | 'gruvbox'
  | 'twilight'
  | 'dracula'
  | 'catppuccin-dark'
  | 'github-light'
  | 'solarized-light'
  | 'catppuccin-light'
  | 'one-light'
  | 'gruvbox-light'

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
  /** Drives `color-scheme` so native controls (scrollbars, form widgets) match. */
  mode: 'light' | 'dark'
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
  mode: 'dark',
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
  mode: 'dark',
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
  mode: 'dark',
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

const GITHUB_LIGHT: Theme = {
  id: 'github-light',
  label: 'GitHub Light',
  mode: 'light',
  tokens: {
    bg: '#ffffff',
    surface: '#f6f8fa',
    surface2: '#eaeef2',
    line: '#d0d7de',
    fg: '#1f2328',
    fgMuted: '#656d76',
    accent: '#0969da',
    ok: '#1a7f37',
    warn: '#9a6700',
    err: '#cf222e',
    working: '#0969da',
    waiting: '#9a6700',
    done: '#1a7f37',
    stale: '#656d76',
  },
  xterm: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#c8e1ff',
    ansi: [
      '#24292f', '#cf222e', '#116329', '#4d9d0f', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#1a7f37', '#4d9d0f', '#218bff', '#6639ba', '#3192aa', '#8c959f',
    ],
  },
}

const SOLARIZED_LIGHT: Theme = {
  id: 'solarized-light',
  label: 'Solarized Light',
  mode: 'light',
  tokens: {
    bg: '#fdf6e3',
    surface: '#eee8d5',
    surface2: '#e4dcc3',
    line: '#d9d2b8',
    fg: '#073642',
    fgMuted: '#586e75',
    accent: '#268bd2',
    ok: '#657b00',
    warn: '#b58900',
    err: '#dc322f',
    working: '#268bd2',
    waiting: '#b58900',
    done: '#657b00',
    stale: '#586e75',
  },
  xterm: {
    background: '#fdf6e3',
    foreground: '#073642',
    cursor: '#268bd2',
    selectionBackground: '#eee8d5',
    ansi: [
      '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3',
    ],
  },
}

const CATPPUCCIN_LIGHT: Theme = {
  id: 'catppuccin-light',
  label: 'Catppuccin Latte',
  mode: 'light',
  tokens: {
    bg: '#eff1f5',
    surface: '#e6e9ef',
    surface2: '#dce0e8',
    line: '#ccd0da',
    fg: '#4c4f69',
    fgMuted: '#5c5f77',
    accent: '#1e66f5',
    ok: '#40a02b',
    warn: '#df8e1d',
    err: '#d20f39',
    working: '#1e66f5',
    waiting: '#df8e1d',
    done: '#40a02b',
    stale: '#5c5f77',
  },
  xterm: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#1e66f5',
    selectionBackground: '#bcc0cc',
    ansi: [
      '#4c4f69', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#8839ef', '#179299', '#acb0be',
      '#8c8fa1', '#e64553', '#40a02b', '#df8e1d', '#209fb5', '#8839ef', '#179299', '#6c6f85',
    ],
  },
}

const ONE_LIGHT: Theme = {
  id: 'one-light',
  label: 'One Light',
  mode: 'light',
  tokens: {
    bg: '#fafafa',
    surface: '#ffffff',
    surface2: '#f0f0f1',
    line: '#d7d9dc',
    fg: '#383a42',
    fgMuted: '#65666d',
    accent: '#4078f2',
    ok: '#50a14f',
    warn: '#c18401',
    err: '#e45649',
    working: '#4078f2',
    waiting: '#c18401',
    done: '#50a14f',
    stale: '#65666d',
  },
  xterm: {
    background: '#fafafa',
    foreground: '#383a42',
    cursor: '#4078f2',
    selectionBackground: '#d7e5fb',
    ansi: [
      '#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7',
      '#4f525b', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#090a0b',
    ],
  },
}

const GRUVBOX_LIGHT: Theme = {
  id: 'gruvbox-light',
  label: 'Gruvbox Light',
  mode: 'light',
  tokens: {
    bg: '#f9f5d7',
    surface: '#ebdbb2',
    surface2: '#d5c4a1',
    line: '#bdae93',
    fg: '#3c3836',
    fgMuted: '#665c54',
    accent: '#076678',
    ok: '#79740e',
    warn: '#b57614',
    err: '#9d0006',
    working: '#076678',
    waiting: '#b57614',
    done: '#79740e',
    stale: '#665c54',
  },
  xterm: {
    background: '#f9f5d7',
    foreground: '#3c3836',
    cursor: '#076678',
    selectionBackground: '#d5c4a1',
    ansi: [
      '#3c3836', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#7c6f64',
      '#928374', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#3c3836',
    ],
  },
}

const DRACULA: Theme = {
  id: 'dracula',
  label: 'Dracula',
  mode: 'dark',
  tokens: {
    bg: '#282a36',
    surface: '#343746',
    surface2: '#44475a',
    line: '#565a73',
    fg: '#f8f8f2',
    fgMuted: '#8b95c9',
    accent: '#bd93f9',
    ok: '#50fa7b',
    warn: '#f1fa8c',
    err: '#ff5555',
    working: '#bd93f9',
    waiting: '#f1fa8c',
    done: '#50fa7b',
    stale: '#8b95c9',
  },
  xterm: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#bd93f9',
    selectionBackground: '#44475a',
    ansi: [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#f8f8f2',
    ],
  },
}

const CATPPUCCIN_DARK: Theme = {
  id: 'catppuccin-dark',
  label: 'Catppuccin Mocha',
  mode: 'dark',
  tokens: {
    bg: '#181825',
    surface: '#1e1e2e',
    surface2: '#313244',
    line: '#45475a',
    fg: '#cdd6f4',
    fgMuted: '#a6adc8',
    accent: '#89b4fa',
    ok: '#a6e3a1',
    warn: '#f9e2af',
    err: '#f38ba8',
    working: '#89b4fa',
    waiting: '#f9e2af',
    done: '#a6e3a1',
    stale: '#a6adc8',
  },
  xterm: {
    background: '#181825',
    foreground: '#cdd6f4',
    cursor: '#89b4fa',
    selectionBackground: '#313244',
    ansi: [
      '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#cba6f7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#cba6f7', '#94e2d5', '#a6adc8',
    ],
  },
}

export const THEMES: Record<ThemeId, Theme> = {
  night: NIGHT,
  gruvbox: GRUVBOX,
  twilight: TWILIGHT,
  dracula: DRACULA,
  'catppuccin-dark': CATPPUCCIN_DARK,
  'github-light': GITHUB_LIGHT,
  'solarized-light': SOLARIZED_LIGHT,
  'catppuccin-light': CATPPUCCIN_LIGHT,
  'one-light': ONE_LIGHT,
  'gruvbox-light': GRUVBOX_LIGHT,
}

export const THEME_IDS: ThemeId[] = [
  'night',
  'gruvbox',
  'twilight',
  'dracula',
  'catppuccin-dark',
  'github-light',
  'solarized-light',
  'catppuccin-light',
  'one-light',
  'gruvbox-light',
]

export const DEFAULT_THEME: ThemeId = 'night'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEMES
}

/** Apply a theme: CSS custom properties, data-theme hook, iPhone chrome tint. */
export function applyTheme(id: ThemeId): void {
  const theme = THEMES[id]
  const root = document.documentElement
  root.dataset.theme = id
  root.style.colorScheme = theme.mode
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
