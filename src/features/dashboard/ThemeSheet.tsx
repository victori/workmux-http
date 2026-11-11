import { BottomSheet } from '../../components/BottomSheet'
import { THEMES, THEME_IDS } from '../../lib/themes'
import type { ThemeId, ThemeTokens } from '../../lib/themes'

const SWATCH_KEYS: (keyof ThemeTokens)[] = ['bg', 'fg', 'accent', 'ok', 'err']

const MODE_LABEL: Record<'dark' | 'light', string> = { dark: 'Dark', light: 'Light' }

/** Theme picker: radio rows with live swatch previews; select applies + persists. */
export function ThemeSheet({
  themeId,
  onSelect,
  onClose,
}: {
  themeId: ThemeId
  onSelect: (id: ThemeId) => void
  onClose: () => void
}) {
  return (
    <BottomSheet title="Theme" onClose={onClose}>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Color theme">
        {(['dark', 'light'] as const).map((mode) => (
          <div key={mode} className="flex flex-col gap-2">
            <p className="px-1 pt-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
              {MODE_LABEL[mode]}
            </p>
            {THEME_IDS.map((id) => THEMES[id])
              .filter((theme) => theme.mode === mode)
              .map((theme) => {
                const active = theme.id === themeId
                return (
                  <button
                    key={theme.id}
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      onSelect(theme.id)
                      onClose()
                    }}
                    className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left ${
                      active ? 'border-accent' : 'border-line'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex gap-1" aria-hidden>
                        {SWATCH_KEYS.map((k) => (
                          <span
                            key={k}
                            className="h-5 w-5 rounded-full border border-line"
                            style={{ backgroundColor: theme.tokens[k] }}
                          />
                        ))}
                      </span>
                      <span className="text-sm font-medium text-fg">{theme.label}</span>
                    </span>
                    {active && <span className="text-sm text-accent" aria-hidden>✓</span>}
                  </button>
                )
              })}
          </div>
        ))}
      </div>
    </BottomSheet>
  )
}
