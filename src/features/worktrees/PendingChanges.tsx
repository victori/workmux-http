export interface PendingChangesProps {
  untracked: string[]
  unstaged: string[]
  /** Paths already staged; each shows Restore (unstage) instead of Add. */
  staged: string[]
  conflicts: string[]
  busy: boolean
  /** Stage the given paths; conflicts are never included. */
  onAdd: (paths: string[]) => void
  /** Undo staging for the given paths; worktree content untouched. */
  onRemove: (paths: string[]) => void
}

/**
 * Untracked + unstaged files with per-file and bulk staging; staged files
 * with per-file and bulk Restore (unstage). Conflicts are listed for
 * awareness only — resolving them is out of scope, so they are never
 * auto-added and never restorable here.
 */
export function PendingChanges({ untracked, unstaged, staged, conflicts, busy, onAdd, onRemove }: PendingChangesProps) {
  const addable = [...untracked, ...unstaged]
  if (addable.length === 0 && conflicts.length === 0 && staged.length === 0) return null

  return (
    <section
      aria-label="Pending changes"
      className="shrink-0 rounded-lg border border-line bg-surface"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
          Pending changes
          {conflicts.length > 0 && <span className="ml-2 text-err">· {conflicts.length} conflict(s)</span>}
        </h3>
        {addable.length > 0 && (
          <button
            onClick={() => onAdd(addable)}
            disabled={busy}
            className="min-h-0 rounded-md border border-accent/40 px-2.5 py-1 text-xs text-accent disabled:opacity-45"
          >
            Add all ({addable.length})
          </button>
        )}
        {staged.length > 0 && (
          <button
            onClick={() => onRemove(staged)}
            disabled={busy}
            title="Unstage all — file changes are kept"
            className="min-h-0 rounded-md border border-warn/40 px-2.5 py-1 text-xs text-warn disabled:opacity-45"
          >
            Restore all ({staged.length})
          </button>
        )}
      </div>
      <ul className="max-h-44 divide-y divide-line overflow-y-auto">
        {conflicts.map((p) => (
          <li key={`c:${p}`} className="flex items-center gap-2 px-3 py-1.5">
            <span aria-hidden className="shrink-0 text-err">⚠</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-err" title={`${p} — unresolved conflict`}>
              {p}
            </span>
            <span className="shrink-0 text-[10px] text-err">conflict</span>
          </li>
        ))}
        {untracked.map((p) => (
          <li key={`u:${p}`} className="flex items-center gap-2 px-3 py-1.5">
            <span aria-hidden className="shrink-0 text-ok">🆕</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={p}>
              {p}
            </span>
            <button
              onClick={() => onAdd([p])}
              disabled={busy}
              aria-label={`Add ${p} to commit`}
              className="min-h-0 shrink-0 rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-45"
            >
              Add
            </button>
          </li>
        ))}
        {unstaged.map((p) => (
          <li key={`s:${p}`} className="flex items-center gap-2 px-3 py-1.5">
            <span aria-hidden className="shrink-0 text-warn">✏</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={p}>
              {p}
            </span>
            <button
              onClick={() => onAdd([p])}
              disabled={busy}
              aria-label={`Add ${p} to commit`}
              className="min-h-0 shrink-0 rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-45"
            >
              Add
            </button>
          </li>
        ))}
        {staged.map((p) => (
          <li key={`st:${p}`} className="flex items-center gap-2 px-3 py-1.5">
            <span aria-hidden className="shrink-0 text-accent">✔</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={`${p} — staged`}>
              {p}
            </span>
            <button
              onClick={() => onRemove([p])}
              disabled={busy}
              aria-label={`Restore ${p} — unstage, keeps file changes`}
              title="Unstage — file changes are kept"
              className="min-h-0 shrink-0 rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-45"
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
