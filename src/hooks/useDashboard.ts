import { useCallback, useEffect, useRef, useState } from 'react'
import type { DashboardSnapshot } from '@shared/types'
import { api } from '../lib/api'

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'stale'

export interface DashboardState {
  snapshot: DashboardSnapshot | null
  connection: ConnectionState
  lastOkAt: number | null
  error: string | null
  refresh: (force?: boolean) => void
}

const POLL_MS = 2000

/**
 * Data freshness from source health + polling only. Per-agent staleness
 * (idle > staleAfterSecs) is an attention signal rendered as badges — it
 * must NOT claim the dashboard data itself is outdated.
 */
export function deriveConnection(
  snapshot: DashboardSnapshot | null,
  error: string | null,
  lastOkAt: number | null,
): ConnectionState {
  if (!snapshot) return error ? 'offline' : 'connecting'
  if (error) return 'offline'
  const statuses = Object.values(snapshot.sources)
  const failed = statuses.filter((s) => !s.ok).length
  if (failed === statuses.length) return 'offline'
  if (failed > 0) return 'stale'
  if (lastOkAt && Date.now() - lastOkAt > POLL_MS * 5) return 'stale'
  return 'online'
}

/**
 * Polls core data every 2s while the tab is visible; pauses when hidden and
 * fetches fresh on return, foregrounding, or network recovery. Overlapping
 * refreshes are collapsed by the server-side TTL cache.
 */
export function useDashboard(): DashboardState {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastOkAt, setLastOkAt] = useState<number | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback((force = false) => {
    if (inFlight.current) return
    inFlight.current = true
    api
      .dashboard(force)
      .then((snap) => {
        setSnapshot(snap)
        setLastOkAt(Date.now())
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        inFlight.current = false
      })
  }, [])

  useEffect(() => {
    refresh(true)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh(false)
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(true)
    }
    const onOnline = () => refresh(true)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onVisible)
    }
  }, [refresh])

  const connection = deriveConnection(snapshot, error, lastOkAt)

  return { snapshot, connection, lastOkAt, error, refresh }
}
