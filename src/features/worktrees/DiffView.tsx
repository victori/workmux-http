import { useCallback, useEffect, useState } from 'react'
import type {
  AgentView,
  DiffFile,
  DiffMode,
  DiffResponse,
  OperationView,
  PreparedAction,
} from '@shared/types'
import { api } from '../../lib/api'
import type { ConnectionState } from '../../hooks/useDashboard'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { HunkList, hunkKey } from './HunkList'
import { CommitBar } from './CommitBar'
import { PendingChanges } from './PendingChanges'

export interface DiffViewProps {
  worktreeId: string
  label: string
  onClose: () => void
  connection: ConnectionState
}

function FileStats({ file }: { file: DiffFile }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-ok">+{file.additions}</span>{' '}
      <span className="text-err">-{file.deletions}</span>
    </span>
  )
}

export function DiffView({ worktreeId, label, onClose, connection }: DiffViewProps) {
  const [mode, setMode] = useState<DiffMode>('wip')
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [patchMode, setPatchMode] = useState(false)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [stagedKeys, setStagedKeys] = useState<Set<string>>(new Set())
  const [stagedPieces, setStagedPieces] = useState<Set<string>>(new Set())
  const [pieces, setPieces] = useState<Map<string, string[]>>(new Map())
  const [busyHunk, setBusyHunk] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [commentTarget, setCommentTarget] = useState<{ file: string; hunkIndex: number } | null>(null)
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [agents, setAgents] = useState<AgentView[]>([])
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [commitNote, setCommitNote] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedAction | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [op, setOp] = useState<OperationView | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [addNote, setAddNote] = useState<string | null>(null)
  const [commitOp, setCommitOp] = useState<OperationView | null>(null)
  const [commitBusy, setCommitBusy] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api
      .diff(worktreeId, mode)
      .then((d) => {
        setDiff(d)
        // fresh snapshot: local hunk bookkeeping no longer applies
        setSkipped(new Set())
        setStagedKeys(new Set())
        setStagedPieces(new Set())
        setPieces(new Map())
        setSelected((prev) =>
          prev && d.files.some((f) => f.path === prev) ? prev : d.files[0]?.path ?? null,
        )
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [worktreeId, mode])

  useEffect(() => {
    load()
  }, [load])

  // Commit instruction + PR link come from the dashboard snapshot, keyed by worktree id.
  useEffect(() => {
    let live = true
    api
      .dashboard()
      .then((s) => {
        if (!live) return
        setAgents(s.agents)
        setPrUrl(s.worktrees.find((w) => w.id === worktreeId)?.prUrl ?? null)
      })
      .catch(() => {
        /* ConnectionStateBanner in App already reports connection problems */
      })
    return () => {
      live = false
    }
  }, [worktreeId, diff?.observedAt])

  // Poll merge operation every second until terminal state.
  useEffect(() => {
    if (!op || (op.state !== 'running' && op.state !== 'unknown')) return
    const t = setInterval(() => {
      api
        .operation(op.id)
        .then(setOp)
        .catch(() => {
          /* transient poll failure; next tick retries */
        })
    }, 1000)
    return () => clearInterval(t)
  }, [op?.id, op?.state])

  useEffect(() => {
    if (op?.state === 'done') {
      setNotice('merge complete')
      load()
    }
  }, [op?.state, load])

  function addPending(paths: string[]): void {
    setAddBusy(true)
    setAddNote(null)
    api
      .addPaths(worktreeId, paths)
      .then((r) => {
        setAddNote(
          r.ok
            ? `${paths.length} file${paths.length === 1 ? '' : 's'} staged`
            : `${r.message ?? 'some paths could not be added'}${r.offenders?.length ? `: ${r.offenders.join(', ')}` : ''}`,
        )
        load()
      })
      .catch((err: unknown) => setAddNote(err instanceof Error ? err.message : String(err)))
      .finally(() => setAddBusy(false))
  }

  function runCommit(message: string): void {
    setCommitOp(null)
    setCommitError(null)
    setCommitBusy(true)
    api
      .commit(worktreeId, message)
      .then(({ operationId }) => api.operation(operationId))
      .then(setCommitOp)
      .catch((err: unknown) => {
        setCommitBusy(false)
        setCommitError(err instanceof Error ? err.message : String(err))
      })
  }

  // Poll the commit operation every second until terminal state.
  useEffect(() => {
    if (!commitOp || (commitOp.state !== 'running' && commitOp.state !== 'unknown')) return
    const t = setInterval(() => {
      api
        .operation(commitOp.id)
        .then(setCommitOp)
        .catch(() => {
          /* transient poll failure; next tick retries */
        })
    }, 1000)
    return () => clearInterval(t)
  }, [commitOp?.id, commitOp?.state])

  useEffect(() => {
    if (!commitOp) return
    if (commitOp.state === 'done') {
      setCommitBusy(false)
      setCommitError(null)
      setNotice('committed')
      load()
    } else if (commitOp.state === 'failed') {
      setCommitBusy(false)
      setCommitError(`commit failed: ${commitOp.error ?? 'unknown error'}`)
      load()
    }
  }, [commitOp?.state, load])

  const wtAgents = agents.filter((a) => a.worktreeId === worktreeId)
  const commitAgent = wtAgents.length === 1 ? wtAgents[0]! : null

  function switchMode(next: DiffMode): void {
    if (next === mode) return
    setPatchMode(false)
    setNotice(null)
    setMode(next)
  }

  function refreshAfterNotice(message: string): void {
    setNotice(message)
    load()
  }

  function stageWhole(file: string, hunkIndex: number): void {
    if (!diff) return
    const key = hunkKey(file, hunkIndex)
    setBusyHunk(key)
    api
      .hunkAction(worktreeId, 'stage', { snapshotId: diff.snapshotId, file, hunkIndex })
      .then((r) => {
        if (r.snapshotStale) return refreshAfterNotice('diff changed, reloaded')
        if (!r.ok) return setNotice(r.message ?? 'stage failed')
        setStagedKeys((prev) => new Set(prev).add(key))
        refreshAfterNotice('hunk staged')
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusyHunk(null))
  }

  function stagePiece(file: string, hunkIndex: number, piece: string): void {
    if (!diff) return
    const key = hunkKey(file, hunkIndex)
    setBusyHunk(key)
    api
      .hunkAction(worktreeId, 'stage', { snapshotId: diff.snapshotId, file, hunkIndex, piece })
      .then((r) => {
        if (r.snapshotStale) return refreshAfterNotice('diff changed, reloaded')
        if (!r.ok) return setNotice(r.message ?? 'stage failed')
        setStagedPieces((prev) => new Set(prev).add(`${key}:${piece}`))
        refreshAfterNotice('piece staged')
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusyHunk(null))
  }

  function unstage(file: string, hunkIndex: number, piece?: string): void {
    if (!diff) return
    const key = hunkKey(file, hunkIndex)
    setBusyHunk(key)
    api
      .hunkAction(worktreeId, 'unstage', {
        snapshotId: diff.snapshotId,
        file,
        hunkIndex,
        ...(piece !== undefined ? { piece } : {}),
      })
      .then((r) => {
        if (r.snapshotStale) return refreshAfterNotice('diff changed, reloaded')
        if (!r.ok) return setNotice(r.message ?? 'unstage failed')
        setStagedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        setStagedPieces((prev) => {
          const next = new Set(prev)
          next.delete(`${key}:${piece}`)
          return next
        })
        refreshAfterNotice('hunk unstaged')
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusyHunk(null))
  }

  function splitHunk(file: string, hunkIndex: number): void {
    if (!diff) return
    const key = hunkKey(file, hunkIndex)
    setBusyHunk(key)
    api
      .hunkAction(worktreeId, 'split', { snapshotId: diff.snapshotId, file, hunkIndex })
      .then((r) => {
        if (r.snapshotStale) return refreshAfterNotice('diff changed, reloaded')
        if (!r.ok || !r.pieces || r.pieces.length === 0) return setNotice(r.message ?? 'split failed')
        setPieces((prev) => new Map(prev).set(key, r.pieces as string[]))
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusyHunk(null))
  }

  function toggleSkip(file: string, hunkIndex: number): void {
    const key = hunkKey(file, hunkIndex)
    setSkipped((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function submitComment(): void {
    if (!diff || !commentTarget || commentText.trim() === '') return
    setCommentBusy(true)
    api
      .hunkComment(worktreeId, {
        snapshotId: diff.snapshotId,
        file: commentTarget.file,
        hunkIndex: commentTarget.hunkIndex,
        comment: commentText,
        agentId: commitAgent?.id,
      })
      .then(() => {
        setCommentTarget(null)
        setCommentText('')
        setNotice('comment delivered to agent')
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => setCommentBusy(false))
  }

  function sendCommit(): void {
    if (!commitAgent) return
    api
      .message(commitAgent.id, 'commit', crypto.randomUUID())
      .then((r) =>
        setCommitNote(r.delivered === 'sent' ? 'commit instruction sent' : 'delivery uncertain'),
      )
      .catch((err: unknown) => setCommitNote(err instanceof Error ? err.message : String(err)))
  }

  function startMerge(): void {
    setOp(null)
    api
      .prepare({ action: 'merge', targetId: worktreeId })
      .then(setPrepared)
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
  }

  function confirmMerge(acceptWarnings: boolean): void {
    if (!prepared?.confirmToken) return
    setMergeBusy(true)
    api
      .execute({
        action: 'merge',
        targetId: worktreeId,
        acceptWarnings,
        confirmToken: prepared.confirmToken,
        requestId: crypto.randomUUID(),
      })
      .then((o) => {
        setPrepared(null)
        setOp(o)
      })
      .catch((err: unknown) => {
        setPrepared(null)
        setNotice(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setMergeBusy(false))
  }

  const files = diff?.files ?? []
  const selectedFile = files.find((f) => f.path === selected) ?? null
  const showUnborn = diff?.unborn === true
  const showBaseMissing = diff?.baseMissing === true && mode === 'branch'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: segmented mode control + close */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2 safe-top">
        <div role="group" aria-label="diff mode" className="flex overflow-hidden rounded-lg border border-line">
          {(['wip', 'branch'] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={`px-3 py-2 text-sm ${mode === m ? 'bg-surface-2 text-accent' : 'text-fg-muted'}`}
            >
              {m === 'wip' ? 'WIP' : 'Review'}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-sm text-fg-muted" title={label}>
          {label}
          {diff?.base ? <span className="text-fg-muted/60"> · base {diff.base}</span> : null}
        </span>
        {mode === 'wip' && (
          <button
            onClick={() => setPatchMode((v) => !v)}
            aria-pressed={patchMode}
            className={`shrink-0 rounded-lg border px-3 py-2 text-sm ${
              patchMode ? 'border-accent text-accent' : 'border-line text-fg-muted'
            }`}
          >
            Stage hunks
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close diff"
          className="shrink-0 rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
        >
          ✕
        </button>
      </div>

      {connection !== 'online' && (
        <div className="shrink-0 bg-warn/10 px-3 py-1.5 text-xs text-warn">Data may be stale ({connection})</div>
      )}
      {notice && (
        <div className="flex shrink-0 items-center justify-between gap-2 bg-accent/10 px-3 py-1.5 text-xs text-accent">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice" className="text-fg-muted">
            ✕
          </button>
        </div>
      )}
      {commitNote && <div className="shrink-0 bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">{commitNote}</div>}
      {op && (
        <div className="shrink-0 border-b border-line bg-surface-2 px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            {op.state === 'running' && <span aria-hidden className="pulse-dot text-accent">●</span>}
            <span className={op.state === 'failed' ? 'text-err' : op.state === 'done' ? 'text-ok' : 'text-fg-muted'}>
              merge {op.state}
            </span>
          </div>
          {op.output && (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-fg-muted">
              {op.output}
            </pre>
          )}
          {op.state === 'failed' && op.error && (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-err">{op.error}</pre>
          )}
          {op.state === 'done' && (
            <button onClick={load} className="mt-1 rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface">
              Reload diff
            </button>
          )}
        </div>
      )}

      {/* Body: file sidebar + hunk list */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {files.length > 0 && (
          <div className="shrink-0 border-b border-line md:w-60 md:overflow-y-auto md:border-b-0 md:border-r">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              aria-expanded={sidebarOpen}
              className="flex w-full items-center justify-between px-3 py-2 text-xs text-fg-muted md:hidden"
            >
              <span>Files ({files.length})</span>
              <span aria-hidden>{sidebarOpen ? '▾' : '▸'}</span>
            </button>
            {sidebarOpen && (
              <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col">
                {files.map((f) => (
                  <li key={f.path} className="shrink-0 md:shrink">
                    <button
                      onClick={() => setSelected(f.path)}
                      aria-current={selected === f.path}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${
                        selected === f.path ? 'bg-surface-2 text-accent' : 'text-fg-muted hover:bg-surface-2'
                      }`}
                    >
                      <span className="max-w-[45vw] truncate md:max-w-none" title={f.path}>
                        {f.path}
                      </span>
                      <FileStats file={f} />
                    </button>
                  </li>
                ))}
                {diff && diff.untracked.length > 0 && (
                  <li className="px-2 pt-1 text-[11px] text-fg-muted md:border-t md:border-line">
                    untracked: {diff.untracked.length}
                  </li>
                )}
              </ul>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!loading && !error && mode === 'wip' && diff && (diff.untracked.length > 0 || diff.unstaged.length > 0 || diff.conflicts.length > 0) && (
            <div className="mb-3 space-y-1">
              <PendingChanges
                untracked={diff.untracked}
                unstaged={diff.unstaged}
                conflicts={diff.conflicts}
                busy={addBusy}
                onAdd={addPending}
              />
              {addNote && (
                <p role="status" aria-live="polite" className="text-[11px] text-fg-muted">
                  {addNote}
                </p>
              )}
            </div>
          )}
          {loading && (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <span aria-hidden className="pulse-dot text-accent">●</span>
              Loading diff…
            </div>
          )}
          {!loading && error && (
            <div className="space-y-2">
              <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
              <button
                onClick={load}
                className="rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && showUnborn && (
            <div className="space-y-2">
              <p className="text-sm text-fg-muted">Repository has no commits yet.</p>
              {diff && diff.untracked.length > 0 && (
                <ul className="space-y-1">
                  {diff.untracked.map((p) => (
                    <li key={p} className="truncate font-mono text-xs text-ok" title={p}>
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!loading && !error && !showUnborn && showBaseMissing && (
            <p className="text-sm text-warn">
              Base branch not configured for this project; set <code className="font-mono">base_branch</code> in
              .workmux.yaml
            </p>
          )}
          {!loading && !error && !showUnborn && !showBaseMissing && diff?.truncated && (
            <p className="mb-2 rounded-lg bg-warn/10 px-3 py-1.5 text-xs text-warn">diff truncated</p>
          )}
          {!loading && !error && !showUnborn && !showBaseMissing && selectedFile && (
            <div className="space-y-3">
              {selectedFile.binary ? (
                <p className="text-sm text-fg-muted">
                  {selectedFile.additions > 0 || selectedFile.deletions > 0
                    ? `Binary file +${selectedFile.additions} -${selectedFile.deletions} bytes not shown`
                    : 'Binary file not shown'}
                </p>
              ) : (
                <HunkList
                  hunks={selectedFile.hunks}
                  patchMode={patchMode && mode === 'wip'}
                  skipped={skipped}
                  stagedKeys={stagedKeys}
                  stagedPieces={stagedPieces}
                  pieces={pieces}
                  busyKey={busyHunk}
                  onStage={stageWhole}
                  onUnstage={unstage}
                  onStagePiece={stagePiece}
                  onUnstagePiece={unstage}
                  onSplit={splitHunk}
                  onToggleSkip={toggleSkip}
                  onComment={(file, hunkIndex) => {
                    setCommentTarget({ file, hunkIndex })
                    setCommentText('')
                  }}
                />
              )}
              {selectedFile.binary === false && selectedFile.hunks.length === 0 && (
                <p className="text-sm text-fg-muted">No hunks for this file.</p>
              )}
            </div>
          )}
          {!loading && !error && !showUnborn && !showBaseMissing && diff && files.length === 0 && (
            <p className="text-sm text-fg-muted">No changes.</p>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2 safe-bottom">
        {diff?.commitCmd ? (
          <CommitBar
            commitCmd={diff.commitCmd}
            busy={commitBusy || commitOp?.state === 'running'}
            error={commitError}
            onCommit={runCommit}
          />
        ) : (
          <button
            onClick={sendCommit}
            disabled={!commitAgent}
            title={
              commitAgent
                ? 'Send "commit" to the worktree agent'
                : wtAgents.length > 1
                  ? 'Multiple agents in this worktree — open one explicitly'
                  : 'No agent running in this worktree'
            }
            className="rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
          >
            Commit{commitAgent ? '' : ' (no agent in this worktree)'}
          </button>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-line px-3 py-2 text-sm text-accent hover:bg-surface-2"
          >
            PR ↗
          </a>
        )}
        <button
          onClick={startMerge}
          disabled={op?.state === 'running'}
          className="ml-auto rounded-lg border border-err/40 px-3 py-2 text-sm text-err hover:bg-err/10"
        >
          Merge
        </button>
      </div>

      {prepared && (
        <ConfirmDialog
          title="Merge worktree"
          targetLabel={prepared.targetLabel}
          warnings={prepared.warnings}
          blocked={prepared.blocked}
          confirmLabel="Merge"
          busy={mergeBusy}
          onConfirm={confirmMerge}
          onCancel={() => setPrepared(null)}
        />
      )}

      {commentTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Hunk comment"
            className="w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-2xl"
          >
            <h2 className="text-sm font-semibold text-fg">
              Comment on {commentTarget.file} · hunk {commentTarget.hunkIndex + 1}
            </h2>
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              rows={4}
              autoFocus
              placeholder="Comment for the agent…"
              className="mt-2 w-full rounded-lg border border-line bg-bg px-3 py-2 text-base text-fg md:text-sm"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setCommentTarget(null)}
                className="rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                onClick={submitComment}
                disabled={commentBusy || commentText.trim() === ''}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg"
              >
                {commentBusy ? 'Sending…' : 'Send comment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
