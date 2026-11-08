import type { ConnectionState } from '../hooks/useDashboard'

export interface ConnectionStateBannerProps {
  connection: ConnectionState
  error: string | null
  onRetry: () => void
}

/**
 * Persistent status strip. Online renders nothing (idle agents are badges,
 * not a data-freshness warning); connecting shows a loading hint; offline
 * and stale (source or polling failures) are color-coded with Retry.
 */
export function ConnectionStateBanner({ connection, error, onRetry }: ConnectionStateBannerProps) {
  if (connection === 'online') return null

  const isStale = connection === 'stale'
  const isOffline = connection === 'offline'
  const isLoading = connection === 'connecting' && !error

  const tone = isOffline
    ? 'bg-err/15 text-err border-b border-err/30'
    : isStale
      ? 'bg-warn/15 text-warn border-b border-warn/30'
      : 'bg-surface-2 text-fg-muted border-b border-line'

  const label = isOffline
    ? 'Disconnected — sessions keep running; sending disabled'
    : isStale
      ? 'Data may be outdated'
      : 'Loading…'

  return (
    <div role="status" aria-live="polite" className={`flex items-center gap-2 px-3 py-2 text-xs ${tone}`}>
      <span className="min-w-0 flex-1">
        {label}
        {error && !isLoading ? <span className="block truncate opacity-80">{error}</span> : null}
      </span>
      {(isOffline || isStale) && (
        <button
          onClick={onRetry}
          className="shrink-0 rounded-md border border-current/40 px-3 py-1 font-medium text-current"
        >
          Retry
        </button>
      )}
    </div>
  )
}
