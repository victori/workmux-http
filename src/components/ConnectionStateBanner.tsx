import type { ConnectionState } from '../hooks/useDashboard'

export interface ConnectionStateBannerProps {
  connection: ConnectionState
  stale: boolean
  error: string | null
  onRetry: () => void
}

/**
 * Persistent status strip. Online+fresh renders nothing; connecting shows a
 * loading hint; offline and stale are color-coded with a Retry action.
 */
export function ConnectionStateBanner({ connection, stale, error, onRetry }: ConnectionStateBannerProps) {
  if (connection === 'online' && !stale) return null

  const isStale = connection === 'stale' || stale
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
