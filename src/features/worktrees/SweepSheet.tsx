import { useCallback, useEffect, useRef, useState } from 'react'
import type { OperationView, PreparedSweep, SweepCandidate, SweepItem, SweepScan } from '@shared/types'
import { ApiError, api, newRequestId } from '../../lib/api'
import { loadTab, removeTab, saveTab } from '../../lib/storage'

// Mirrors server BOUNDS.sweepScanMaxTargets / sweepExecuteMaxTargets.
const SCAN_CAP = 100
const POLL_MS = 1000

export interface SweepSheetProps {
  worktreeIds: string[]
  onClose: () => void
  onChanged: () => void
}

type SweepUiState =
  | { phase: 'idle' }
  | { phase: 'scanning'; operationId: string }
  | { phase: 'selecting'; scanId: string; scan: SweepScan }
  | { phase: 'reviewing'; prepared: PreparedSweep; scanId: string; scan: SweepScan }
  | { phase: 'running'; operationId: string; items: SweepItem[] }
  | { phase: 'finished'; operation: OperationView }

const ITEM_LABEL: Record<SweepItem['state'], string> = {
  pending: 'waiting',
  running: 'removing…',
  removed: 'removed',
  skipped: 'skipped',
  failed: 'failed',
  unknown: 'uncertain',
}

const REASON_LABEL: Record<string, string> = {
  pr_merged: 'PR merged',
  pr_closed: 'PR closed',
  upstream_gone: 'upstream gone',
  merged_locally: 'merged into base',
}

function isEligible(c: SweepCandidate): boolean {
  return c.reason !== null && c.blockers.length === 0
}

function itemsFrom(op: OperationView, fallback: SweepItem[]): SweepItem[] {
  return op.result?.type === 'sweep' ? op.result.items : fallback
}

export function SweepSheet({ worktreeIds, onClose, onChanged }: SweepSheetProps) {
  const [ui, setUi] = useState<SweepUiState>(() => {
    const retained = loadTab<string | null>('sweepOperationId', null)
    return retained ? { phase: 'running', operationId: retained, items: [] } : { phase: 'idle' }
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keepBranches, setKeepBranches] = useState(true)
  const [ack, setAck] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const overCap = worktreeIds.length > SCAN_CAP

  const startScan = useCallback(() => {
    if (overCap) {
      setNotice(`Too many worktrees for one scan (max ${SCAN_CAP}). Filter the list first.`)
      return
    }
    setNotice(null)
    setSelected(new Set())
    setAck(false)
    void api
      .scanSweep({ worktreeIds, requestId: newRequestId() })
      .then((op) => setUi({ phase: 'scanning', operationId: op.id }))
      .catch((err: unknown) => {
        setUi({ phase: 'idle' })
        setNotice(err instanceof ApiError ? err.message : String(err))
      })
  }, [overCap, worktreeIds])

  useEffect(() => {
    if (ui.phase === 'idle' && !loadTab<string | null>('sweepOperationId', null)) startScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pollOpId = ui.phase === 'scanning' || ui.phase === 'running' ? ui.operationId : null

  useEffect(() => {
    if (pollOpId === null) return
    const id = pollOpId
    const fallback = ui.phase === 'running' ? ui.items : []
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return
      try {
        const op = await api.operation(id)
        if (cancelled) return
        if (ui.phase === 'scanning') {
          if (op.state === 'running') return
          if (op.state === 'done' && op.result?.type === 'sweep_scan') {
            setUi({ phase: 'selecting', scanId: id, scan: op.result })
          } else {
            setUi({ phase: 'idle' })
            setNotice(op.error ?? 'sweep scan failed')
          }
          return
        }
        if (op.state === 'running') {
          const items = itemsFrom(op, fallback)
          if (items.length > 0) setUi({ phase: 'running', operationId: id, items })
          return
        }
        saveTab('sweepOperationId', id)
        setUi({ phase: 'finished', operation: op })
        onChangedRef.current()
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) {
          removeTab('sweepOperationId')
          setUi({
            phase: 'finished',
            operation: {
              id,
              kind: 'sweep',
              target: '',
              state: 'unknown',
              output: null,
              error: 'sweep operation unavailable after server restart — outcome unknown. Rescan; never assume it ran.',
              startedAt: 0,
              endedAt: Date.now(),
            },
          })
          onChangedRef.current()
        }
        // transient failures keep polling
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pollOpId])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectEligible = (): void => {
    if (ui.phase !== 'selecting') return
    setSelected(new Set(ui.scan.candidates.filter(isEligible).map((c) => c.worktreeId)))
  }

  const changeKeepBranches = (next: boolean): void => {
    setKeepBranches(next)
    // branch mode is bound into the server token; the review must be
    // re-prepared so ancestry is re-evaluated server-side.
    if (ui.phase === 'reviewing') {
      setUi({ phase: 'selecting', scanId: ui.scanId, scan: ui.scan })
    }
  }

  const review = (): void => {
    if (ui.phase !== 'selecting' || selected.size === 0 || submitting) return
    setNotice(null)
    setSubmitting(true)
    const scan = ui.scan
    const scanId = ui.scanId
    void api
      .prepareSweep({ scanId, worktreeIds: [...selected], keepBranches, requestId: newRequestId() })
      .then((prepared) => {
        setSubmitting(false)
        setAck(false)
        setUi({ phase: 'reviewing', prepared, scanId, scan })
      })
      .catch((err: unknown) => {
        setSubmitting(false)
        setNotice(err instanceof ApiError ? `${err.message} — rescan required` : String(err))
      })
  }

  const execute = (): void => {
    if (ui.phase !== 'reviewing' || submitting) return
    setNotice(null)
    setSubmitting(true)
    void api
      .executeSweep({ confirmToken: ui.prepared.confirmToken, acceptWarnings: true, requestId: newRequestId() })
      .then((op) => {
        setSubmitting(false)
        saveTab('sweepOperationId', op.id)
        setUi({
          phase: 'running',
          operationId: op.id,
          items: ui.prepared.targets.map((t) => ({
            worktreeId: t.worktreeId,
            targetLabel: t.targetLabel,
            state: 'pending' as const,
            message: null,
          })),
        })
      })
      .catch((err: unknown) => {
        setSubmitting(false)
        setNotice(err instanceof ApiError ? err.message : String(err))
      })
  }

  const dismiss = (): void => {
    if (ui.phase === 'finished') removeTab('sweepOperationId')
    onClose()
  }

  const eligibleCount = ui.phase === 'selecting' ? ui.scan.candidates.filter(isEligible).length : 0
  const runningItems = ui.phase === 'running' ? ui.items : []
  const finished = ui.phase === 'finished' ? ui.operation : null
  const finishedItems = finished?.result?.type === 'sweep' ? finished.result.items : []

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center" onClick={dismiss}>
      <div
        className="max-h-[85dvh] w-full overflow-auto rounded-t-2xl bg-surface p-4 md:max-w-lg md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-fg">Clean sweep</h2>
          <button onClick={dismiss} className="min-h-[44px] rounded-lg px-3 text-sm text-fg-muted" aria-label="Close sweep">
            ✕
          </button>
        </div>

        {notice && (
          <div role="alert" className="mb-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">
            {notice}
          </div>
        )}

        {ui.phase === 'idle' && (
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              Scans {worktreeIds.length} displayed worktrees for provably clean removal targets. Nothing is removed without
              review and confirmation.
            </p>
            <button
              onClick={startScan}
              disabled={overCap}
              className="min-h-[44px] w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {overCap ? `Too many worktrees (max ${SCAN_CAP})` : 'Start scan'}
            </button>
          </div>
        )}

        {ui.phase === 'scanning' && (
          <div role="status" className="flex items-center gap-2 py-6 text-sm text-fg-muted">
            <span className="pulse-dot h-2 w-2 rounded-full bg-working" />
            Collecting evidence…
          </div>
        )}

        {ui.phase === 'selecting' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-fg-muted">Expires {new Date(ui.scan.expiresAt).toLocaleTimeString()}</p>
              <button
                onClick={selectEligible}
                className="min-h-[44px] rounded-lg border border-line px-3 text-xs text-fg"
              >
                Select eligible ({eligibleCount})
              </button>
            </div>
            <ul className="flex flex-col gap-1.5">
              {ui.scan.candidates.map((c) => {
                const eligible = isEligible(c)
                return (
                  <li key={c.worktreeId} className="rounded-xl border border-line bg-surface-2 p-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={c.targetLabel}
                        className="mt-1 h-5 w-5 shrink-0"
                        disabled={!eligible}
                        checked={selected.has(c.worktreeId)}
                        onChange={() => toggle(c.worktreeId)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm text-fg">{c.targetLabel}</span>
                        <span className="block truncate font-mono text-xs text-fg-muted">{c.branch}</span>
                        {eligible ? (
                          <span className="mt-1 inline-block rounded bg-ok/15 px-1.5 py-0.5 text-[11px] text-ok">
                            {REASON_LABEL[c.reason ?? ''] ?? 'clean'}
                          </span>
                        ) : (
                          <ul className="mt-1 space-y-0.5">
                            {c.reason && (
                              <li className="text-[11px] text-fg-muted">{REASON_LABEL[c.reason]} — blocked:</li>
                            )}
                            {c.blockers.map((b) => (
                              <li key={b} className="text-[11px] text-warn">
                                {b}
                              </li>
                            ))}
                          </ul>
                        )}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={keepBranches}
                onChange={(e) => changeKeepBranches(e.target.checked)}
              />
              Keep local branches (recommended)
            </label>
            <button
              onClick={review}
              disabled={selected.size === 0 || submitting}
              className="min-h-[44px] w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Review selection ({selected.size})
            </button>
          </div>
        )}

        {ui.phase === 'reviewing' && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-fg">{ui.prepared.targets.length} worktrees will be removed</p>
            <ul className="flex flex-col gap-1">
              {ui.prepared.targets.map((t) => (
                <li key={t.worktreeId} className="rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-fg">
                  {t.targetLabel} <span className="text-fg-muted">({t.branch})</span>
                </li>
              ))}
            </ul>
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={ui.prepared.keepBranches}
                onChange={(e) => changeKeepBranches(e.target.checked)}
              />
              Keep local branches (recommended)
            </label>
            <ul className="space-y-1 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
              {ui.prepared.warnings.map((w) => (
                <li key={w} className="text-xs text-warn">
                  {w}
                </li>
              ))}
            </ul>
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-fg">
              <input type="checkbox" className="h-5 w-5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              Acknowledge warnings
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => ui.phase === 'reviewing' && setUi({ phase: 'selecting', scanId: ui.scanId, scan: ui.scan })}
                className="min-h-[44px] flex-1 rounded-lg border border-line px-4 text-sm text-fg"
              >
                Back
              </button>
              <button
                onClick={execute}
                disabled={!ack || submitting}
                className="min-h-[44px] flex-1 rounded-lg bg-err px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                Remove {ui.prepared.targets.length} worktrees
              </button>
            </div>
          </div>
        )}

        {(ui.phase === 'running' || ui.phase === 'finished') && (
          <div role="status" className="space-y-2" aria-live="polite">
            <p className="text-sm font-medium text-fg">
              {finished
                ? finished.state === 'done'
                  ? 'Sweep finished'
                  : `Sweep ended: ${finished.state}`
                : 'Removing worktrees…'}
            </p>
            {(runningItems.length > 0 ? runningItems : finishedItems).map((it) => (
              <div key={it.worktreeId} className="flex items-start justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <span className="min-w-0 truncate font-mono text-xs text-fg">{it.targetLabel}</span>
                <span
                  className={`shrink-0 text-xs ${
                    it.state === 'removed' ? 'text-ok' : it.state === 'unknown' ? 'text-warn' : it.state === 'failed' ? 'text-err' : 'text-fg-muted'
                  }`}
                >
                  {ITEM_LABEL[it.state]}
                  {it.message ? `: ${it.message}` : ''}
                </span>
              </div>
            ))}
            {finished && (
              <>
                {finished.output && <p className="text-xs text-fg-muted">{finished.output}</p>}
                {finished.error && finished.error !== finished.output && <p className="text-xs text-err">{finished.error}</p>}
                <p className="text-[11px] text-fg-muted">
                  Uncertain results were never retried. Rescan to verify current state.
                </p>
                <button
                  onClick={dismiss}
                  className="min-h-[44px] w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
                >
                  Done
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
