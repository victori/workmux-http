# Plan: Theme support (gruvbox / night / twilight)

Date: 2026-11-07 · Status: implemented 2026-11-07 · Repo: workmux-http

## Goal

User-selectable color themes for the SPA: **Night** (current palette, default),
**Gruvbox** (dark, hard variant), **Twilight** (vim twilight, dark). Choice
persists durably across tabs/reloads, applies instantly to every surface —
including the xterm advanced terminal — without a server round-trip.

Decisions baked in (conservative defaults, no open questions blocking work):
- Three dark palettes only. Architecture is data-driven so light variants are
  a later drop-in (new entry + contrast pass), not a refactor.
- Default stays **Night**; existing users see no change.
- Theme selection is client-only (localStorage); no server/API changes.

## Mechanism

All component colors already flow through Tailwind v4 `@theme` tokens
(`--color-bg … --color-stale` in `src/index.css`); utilities compile to
`var(--color-*)` references. Therefore a theme = a map of the 14 token values
applied as inline CSS custom properties on `document.documentElement` +
`data-theme` attribute for CSS/test hooks. `@theme` keeps the Night values as
the pre-JS default (no first-paint flash beyond one frame).

The xterm terminal cannot use CSS vars; each theme carries an explicit xterm
palette (background/foreground/cursor/selectionBackground + ansi 0–15).
`TerminalView.THEME` (hardcoded today, `TerminalView.tsx:14`) is removed and
replaced by the per-theme palette; live switching via `term.options.theme = …`
(xterm supports runtime theme changes — no remount).

## Palettes (token → value)

| token | night (current) | gruvbox (dark hard) | twilight (vim) |
| --- | --- | --- | --- |
| bg | #0b0f14 | #282828 | #141414 |
| surface | #131a22 | #32302f | #1c1b1a |
| surface-2 | #1a232e | #3c3836 | #252321 |
| line | #263241 | #504945 | #33312e |
| fg | #dce3ea | #ebdbb2 | #f4e9d0 |
| fg-muted | #8494a7 | #a89984 | #888375 |
| accent | #4cc2ff | #83a598 | #7587a6 |
| ok | #3fb950 | #b8bb26 | #8f9d6a |
| warn | #d29922 | #fabd2d | #cda869 |
| err | #f85149 | #fb4934 | #cf6a4c |
| working | = accent | = accent | = accent |
| waiting | = warn | = warn | = warn |
| done | = ok | = ok | = ok |
| stale | = fg-muted | = fg-muted | = fg-muted |

Twilight accent = Identifier blue (#7587a6), err = Constant red (#cf6a4c),
ok = String green (#8f9d6a), warn = Statement gold (#cda869) — faithful to
twilight.vim's role palette; accent deliberately avoids the err red so
interactive vs destructive stay distinct.

## File ownership

| File | Change |
| --- | --- |
| `src/lib/themes.ts` | **NEW** — `ThemeId`, `ThemeTokens` (14 tokens + xterm palette incl. ansi16), `THEMES` record, `applyTheme(id)` (sets vars + `data-theme` + `<meta name="theme-color">` for iPhone chrome tint), `currentTheme()`; init reads `loadPref('theme', 'night')`. |
| `src/lib/themes.test.ts` | **NEW** — every theme defines every token; all values valid `#rrggbb`; ids stable; `applyTheme` sets documentElement vars + attribute (jsdom). |
| `src/index.css` | `@theme` unchanged (Night defaults); add nothing theme-specific (single source of truth is themes.ts). |
| `src/App.tsx` | Own `themeId` state (lazy `loadPref`); call `applyTheme` on change; pass `themeId` + `onThemeChange` to DashboardView; pass theme palette to TerminalView; persist via `savePref('theme', …)`. |
| `src/features/dashboard/ThemeSheet.tsx` | **NEW** — BottomSheet with radio rows per theme: name + 5-swatch preview (bg, fg, accent, ok, err); select = apply + persist + close. |
| `src/features/dashboard/ThemeSheet.test.tsx` | **NEW** — renders 3 options, click persists `wmhttp:theme`, fires callback. |
| `src/features/dashboard/DashboardView.tsx` | ⚙ button next to Filters in header (`aria-label="Theme"`); renders ThemeSheet on open. |
| `src/features/terminal/TerminalView.tsx` | Delete hardcoded `THEME`; accept `theme: ThemeTokens`; build xterm theme from prop; `useEffect` on prop → `term.options.theme = …` (live switch while attached). |
| `e2e/theme.spec.ts` | **NEW** — fixture mode: open ⚙ → pick Gruvbox → `html[data-theme="gruvbox"]`, body computed background = #282828, reload persists, switch back to Night. |
| `index.html` | Add `<meta name="theme-color">` (Night default; applyTheme updates). |
| `README.md` | Features bullet: themes + persistence. |
| `AGENTS.md` | Convention: NEVER hardcode colors in components; new tokens go in all three palettes in `themes.ts`; xterm palette lives in `themes.ts` only. |
| `docs/superpowers/plans/2026-11-07-workmux-http-dashboard.md` | `## Amendments` entry on completion (spec-maintenance rule). |

## Dependencies / order

1. `themes.ts` + `themes.test.ts` (no deps) — proves token contract.
2. `App.tsx` wiring + `index.html` meta — theme applies at boot.
3. `ThemeSheet` + `DashboardView` ⚙ — user can switch.
4. `TerminalView` prop refactor — terminal follows.
5. e2e + docs + amendment (after 1–4 green).

Steps 1–2 are the riskiest-assumption gate: **Tailwind v4 utilities must pick
up runtime var overrides.** Verify immediately after step 2 with a browser
smoke (computed `background-color` of `body`/a `bg-surface` card after
`applyTheme('gruvbox')`) before building UI on top. If overrides did NOT
propagate (they should — utilities reference the vars), fallback plan: emit
`:root[data-theme=…] { --color-*: … }` blocks in `index.css` generated from
themes.ts at build time.

## Verification

- `npm run typecheck` — clean.
- `npx vitest run` — 111 → ~118 (themes contract + applyTheme + ThemeSheet
  interaction + existing suites unbroken; DashboardView tests unaffected by
  new button — no name collisions with `Filters`).
- `npx playwright test` — 11 → 12 (new `theme.spec.ts` incl. persistence
  across reload and computed-color assertion).
- Browser visual pass (Playwright screenshots, iPhone 13 viewport): each theme
  on dashboard, agent view, diff view, terminal view (fixture mode restricts
  terminal — terminal visual verified in live read-only smoke instead, no
  sends), checking contrast of muted text + badges.
- Live smoke after build: `/api/health` 200; no server code changes, so no
  server-side verification delta.

## Non-goals

- Light variants, per-agent themes, OS `prefers-color-scheme` auto mode,
  server-side theme state, custom color pickers.
- No new dependencies.
