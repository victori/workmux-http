import type { SortMode } from '@shared/types'
import { BottomSheet } from '../../components/BottomSheet'

const SORTS: { id: SortMode; label: string; hint: string }[] = [
  { id: 'priority', label: 'Priority', hint: 'Waiting → done → working → stale' },
  { id: 'project', label: 'Project', hint: 'Grouped by project, priority inside' },
  { id: 'recency', label: 'Recency', hint: 'Most recently updated first' },
  { id: 'natural', label: 'Natural', hint: 'tmux window / pane order' },
]

export interface FilterSheetProps {
  sort: SortMode
  onSortChange: (mode: SortMode) => void
  hideStale: boolean
  onHideStaleChange: (value: boolean) => void
  sessionFilter: string | null
  onClearSessionFilter: () => void
  onClose: () => void
}

export function FilterSheet({
  sort,
  onSortChange,
  hideStale,
  onHideStaleChange,
  sessionFilter,
  onClearSessionFilter,
  onClose,
}: FilterSheetProps) {
  return (
    <BottomSheet title="Filter & sort" onClose={onClose}>
      <section aria-label="Sort order">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Sort</h3>
        <div role="radiogroup" className="flex flex-col gap-1">
          {SORTS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={sort === s.id}
              onClick={() => {
                onSortChange(s.id)
                onClose()
              }}
              className={`flex min-h-[44px] items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left ${
                sort === s.id ? 'border-accent bg-accent/10 text-accent' : 'border-line text-fg-muted'
              }`}
            >
              <span>
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="block text-xs opacity-70">{s.hint}</span>
              </span>
              {sort === s.id && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-4" aria-label="Filters">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">Filters</h3>
        <button
          role="switch"
          aria-checked={hideStale}
          onClick={() => onHideStaleChange(!hideStale)}
          className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-left"
        >
          <span className="text-sm text-fg">Hide stale agents</span>
          <span
            aria-hidden
            className={`relative h-6 w-11 rounded-full transition-colors ${hideStale ? 'bg-accent' : 'bg-surface-2'}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-fg transition-transform ${
                hideStale ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
        {sessionFilter && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
            <span className="min-w-0 truncate text-sm text-fg-muted">
              Session: <span className="font-mono text-fg">{sessionFilter}</span>
            </span>
            <button onClick={onClearSessionFilter} className="shrink-0 text-sm text-accent">
              Clear
            </button>
          </div>
        )}
      </section>
    </BottomSheet>
  )
}
