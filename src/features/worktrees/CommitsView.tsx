import { useCallback, useEffect, useState } from 'react'
import type { CommitInfo, CommitListResponse } from '@shared/types'
import { api } from '../../lib/api'
import type { ConnectionState } from '../../hooks/useDashboard'

export interface CommitsViewProps {
  worktreeId: string
  label: string
  connection: ConnectionState
  onClose: () => void
  onOpenCommit: (commit: CommitInfo) => void
}

const PAGE = 50

function relativeDate(secs: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - secs)
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

/**
 * Commit history for one worktree (git log HEAD, newest first). Rows open
 * the commit's diff (vs first parent). Read-only; degrades to an error
 * state with retry like the rest of the app.
 */
export function CommitsView({ worktreeId, label, connection, onClose, onOpenCommit }: CommitsViewProps) {
  const [data, setData] = useState<CommitListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    setLoading(true)
    setError(null)
    api
      .commits(worktreeId, PAGE)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [worktreeId])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="safe-top shrink-0 border-b border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            aria-label="Back"
            className="min-h-0 rounded-md border border-line px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
          >
            ← Back
          </button>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={label}>
            Commits · {label}
          </h2>
          <button
            onClick={load}
            aria-label="Reload commits"
            className="min-h-0 rounded-md border border-line px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-2"
          >
            ⟳
          </button>
        </div>
        {connection !== 'online' && (
          <p className="mt-1 text-[11px] text-warn">data may be outdated ({connection})</p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 p-3 text-sm text-fg-muted">
            <span aria-hidden className="pulse-dot text-accent">●</span>
            Loading commits…
          </div>
        )}
        {!loading && error && (
          <div className="space-y-2 p-3">
            <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
            <button
              onClick={load}
              className="rounded-lg border border-accent/40 px-3 py-1.5 text-sm text-accent"
            >
              Retry
            </button>
          </div>
        )}
        {!loading && !error && data && data.commits.length === 0 && (
          <p className="p-3 text-sm text-fg-muted">No commits yet (unborn branch?).</p>
        )}
        {!loading && !error && data && data.commits.length > 0 && (
          <>
            <ul className="divide-y divide-line">
              {data.commits.map((c) => (
                <li key={c.sha}>
                  <button
                    onClick={() => onOpenCommit(c)}
                    aria-label={`Show diff for ${c.short}: ${c.subject}`}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <span className="line-clamp-2 text-sm text-fg">
                      {c.isMerge && <span aria-label="merge commit" className="mr-1 text-warn">⑂</span>}
                      {c.subject}
                    </span>
                    <span className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
                      <span className="text-accent">{c.short}</span>
                      <span className="truncate">{c.author}</span>
                      <span className="shrink-0">{relativeDate(c.dateSecs)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {data.truncated && (
              <p className="px-3 py-2 text-[11px] text-fg-muted">
                Showing the newest {data.commits.length} commits.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
