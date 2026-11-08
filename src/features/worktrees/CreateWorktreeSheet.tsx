import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OperationView, ProjectInfo } from '@shared/types'
import { api } from '../../lib/api'

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

export interface CreateWorktreeSheetProps {
  onClose: () => void
}

function outputTail(output: string | null): string {
  if (!output) return ''
  const lines = output.split('\n')
  return lines.slice(-15).join('\n')
}

export function CreateWorktreeSheet({ onClose }: CreateWorktreeSheetProps) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [project, setProject] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [agent, setAgent] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [op, setOp] = useState<OperationView | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const loadProjects = useCallback(() => {
    setLoadError(null)
    api
      .projects()
      .then(setProjects)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // Poll the create operation every second until terminal state.
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

  // Success: show the confirmation line briefly, then dismiss the sheet.
  useEffect(() => {
    if (op?.state !== 'done') return
    const t = setTimeout(onClose, 1800)
    return () => clearTimeout(t)
  }, [op?.state, onClose])

  const running = submitting || op?.state === 'running' || op?.state === 'unknown'
  const nameValid = NAME_RE.test(name)
  const selectedProject = projects?.find((p) => p.name === project) ?? null
  const visibleProjects = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = projects ?? []
    return q === '' ? list : list.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, filter])

  function submit(): void {
    setNameTouched(true)
    if (!project || !nameValid || running) return
    setSubmitting(true)
    setOp(null)
    api
      .createWorktree({
        project,
        name,
        ...(prompt.trim() !== '' ? { prompt: prompt } : {}),
        ...(agent !== '' ? { agent } : {}),
        ...(baseBranch.trim() !== '' ? { baseBranch: baseBranch.trim() } : {}),
        requestId: crypto.randomUUID(),
      })
      .then(setOp)
      .catch((err: unknown) =>
        setOp({
          id: '',
          kind: 'create_worktree',
          target: `${project}/${name}`,
          state: 'failed',
          output: null,
          error: err instanceof Error ? err.message : String(err),
          startedAt: Date.now(),
          endedAt: Date.now(),
        }),
      )
      .finally(() => setSubmitting(false))
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 md:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New worktree"
        className="max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 shadow-2xl md:max-w-lg md:rounded-2xl safe-bottom"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-fg">New worktree</h2>
          <button onClick={onClose} disabled={running} aria-label="Close" className="rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-surface-2">
            ✕
          </button>
        </div>

        {!op && (
          <div className="mt-3 space-y-4">
            {loadError && (
              <div className="space-y-2">
                <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{loadError}</p>
                <button onClick={loadProjects} className="rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2">
                  Retry
                </button>
              </div>
            )}
            {!loadError && !projects && <p className="text-sm text-fg-muted">Loading projects…</p>}
            {projects && (
              <div>
                <label className="mb-1 block text-xs text-fg-muted" htmlFor="wt-project-filter">Project</label>
                <input
                  id="wt-project-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search projects…"
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-base text-fg md:text-sm"
                />
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {visibleProjects.map((p) => (
                    <li key={p.name}>
                      <button
                        onClick={() => {
                          setProject(p.name)
                          setAgent('')
                        }}
                        aria-pressed={project === p.name}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                          project === p.name ? 'border-accent bg-surface-2 text-accent' : 'border-line text-fg-muted hover:bg-surface-2'
                        }`}
                      >
                        {p.name}
                        <span className="ml-2 text-xs text-fg-muted/70">base: {p.baseBranch ?? 'default'}</span>
                      </button>
                    </li>
                  ))}
                  {visibleProjects.length === 0 && <li className="px-1 text-xs text-fg-muted">No match.</li>}
                </ul>
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs text-fg-muted" htmlFor="wt-name">Name</label>
              <input
                id="wt-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                aria-invalid={nameTouched && !nameValid}
                placeholder="my-feature"
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-base text-fg md:text-sm"
              />
              {nameTouched && !nameValid && (
                <p className="mt-1 text-xs text-err">Name must match [A-Za-z0-9._-], 1–64 characters.</p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs text-fg-muted" htmlFor="wt-prompt">Initial prompt (optional)</label>
              <textarea
                id="wt-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="First task for the agent…"
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-base text-fg md:text-sm"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-fg-muted" htmlFor="wt-agent">Agent profile</label>
                <select
                  id="wt-agent"
                  value={agent}
                  onChange={(e) => setAgent(e.target.value)}
                  disabled={!selectedProject || selectedProject.agents.length === 0}
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-base text-fg md:text-sm"
                >
                  <option value="">project default</option>
                  {selectedProject?.agents.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-fg-muted" htmlFor="wt-base">Base branch (optional)</label>
                <input
                  id="wt-base"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  placeholder={selectedProject?.baseBranch ?? 'config default'}
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-base text-fg md:text-sm"
                />
              </div>
            </div>
          </div>
        )}

        {op && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              {running && <span aria-hidden className="pulse-dot text-accent">●</span>}
              <span className={op.state === 'failed' ? 'text-err' : op.state === 'done' ? 'text-ok' : 'text-fg-muted'}>
                {op.state === 'done' ? 'created; refresh may take a moment' : op.state === 'failed' ? 'creation failed' : 'creating worktree…'}
              </span>
            </div>
            {outputTail(op.output) && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-bg px-3 py-2 font-mono text-xs text-fg-muted">
                {outputTail(op.output)}
              </pre>
            )}
            {op.state === 'failed' && op.error && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-xs text-err">
                {op.error}
              </pre>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          {running && <p className="mr-auto text-[11px] text-warn">creation continues server-side</p>}
          <button
            onClick={onClose}
            disabled={running}
            className="rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
          >
            Cancel
          </button>
          {!op && (
            <button
              onClick={submit}
              disabled={!project || !nameValid || running}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg"
            >
              {running ? 'Creating…' : 'Create'}
            </button>
          )}
          {op?.state === 'failed' && (
            <button onClick={() => setOp(null)} className="rounded-lg border border-accent px-4 py-2 text-sm text-accent">
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
