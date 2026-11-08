export interface SegOption<T extends string> {
  id: T
  label: string
}

export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (id: T) => void
  ariaLabel: string
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`min-h-[36px] flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            value === o.id ? 'bg-surface text-accent shadow-sm' : 'text-fg-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
