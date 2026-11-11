import { useState } from 'react'

import type { CiState, CiSummary, GithubStatus, PullRequestInfo } from '@shared/types'

export interface PrCiStatusProps {
  status: GithubStatus | undefined
}

const CI_LABEL: Record<CiState, string> = {
  passing: 'passing',
  failing: 'failing',
  pending: 'pending',
  none: 'no checks',
  neutral: 'neutral',
  unknown: 'checks unknown',
}

const CI_CLASS: Record<CiState, string> = {
  passing: 'bg-ok/15 text-ok',
  failing: 'bg-err/15 text-err',
  pending: 'bg-warn/15 text-warn',
  none: 'bg-surface-2 text-fg-muted',
  neutral: 'bg-surface-2 text-fg-muted',
  unknown: 'bg-surface-2 text-fg-muted',
}

const PR_LABEL: Record<PullRequestInfo['state'], string> = {
  open: 'open',
  draft: 'draft',
  merged: 'merged',
  closed: 'closed',
}

const REVIEW_LABEL: Record<PullRequestInfo['review'], string | null> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
  unknown: null,
}

function humanizeAge(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null
  const age = Date.now() - ms
  if (age < 60_000) return 'just now'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  return `${Math.floor(age / 86_400_000)}d ago`
}

function ciBadge(ci: CiSummary | null): { label: string; cls: string } {
  if (!ci) return { label: CI_LABEL.unknown, cls: CI_CLASS.unknown }
  const state = ci.state
  let label = CI_LABEL[state]
  if (state === 'failing' || state === 'pending') {
    const n = state === 'failing' ? ci.counts.failing : ci.counts.pending
    label = `${n} ${label}`
  }
  return { label, cls: CI_CLASS[state] }
}

/**
 * PR + CI visibility for one worktree (design §3 display contract).
 * Every degraded state stays honest: unknown is never passing, stale keeps
 * its last-good data labeled as historical, and failures show their reason.
 */
export function PrCiStatus({ status }: PrCiStatusProps) {
  const [checksOpen, setChecksOpen] = useState(false)
  const strip = 'flex h-11 items-center gap-1.5 overflow-x-auto no-scrollbar text-[11px] whitespace-nowrap'
  if (!status) return <div className={strip} />
  if (status.state === 'loading') {
    return (
      <div className={strip}>
        <span role="status" className="inline-flex shrink-0 items-center gap-1 text-fg-muted">
          <span aria-hidden className="pulse-dot text-accent">
            ●
          </span>
          PR/CI loading…
        </span>
      </div>
    )
  }
  if (status.state === 'unsupported') {
    return (
      <div className={strip}>
        <span className="shrink-0 text-fg-muted" title="GitHub status is only supported for github.com remotes">
          GitHub unsupported
        </span>
      </div>
    )
  }
  if (status.state === 'unavailable') {
    return (
      <div className={strip}>
        <span className="inline-flex shrink-0 items-center gap-1 text-fg-muted">
          <span aria-hidden className="text-warn">
            ⚠
          </span>
          <span title={status.error ?? undefined}>
            GitHub unavailable{status.error ? `: ${status.error}` : ''}
          </span>
        </span>
      </div>
    )
  }

  const stale = status.state === 'stale'
  const age = humanizeAge(status.observedAt)
  const badge = ciBadge(status.ci)
  const incomplete = status.ci !== null && (status.ci.state === 'unknown' || !status.ci.complete)
  const hasChecks = status.ci !== null && status.ci.checks.length > 0

  return (
    <div className={stale ? 'opacity-80' : undefined}>
      <div className={strip}>
        {status.pr ? <PrChip pr={status.pr} stale={stale} /> : (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 font-medium whitespace-nowrap text-fg-muted">
            {stale ? 'Last checked: no PR' : 'No PR'}
          </span>
        )}
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 font-medium whitespace-nowrap tabular-nums ${badge.cls} ${stale ? 'border border-dashed border-line' : ''}`}
          title={status.ci ? `checks for ${status.ci.commitOid.slice(0, 7)}` : undefined}
        >
          CI {badge.label}
          {status.ci && status.ci.counts.passing + status.ci.counts.failing + status.ci.counts.pending > 0
            ? ` (${status.ci.counts.passing}✓ ${status.ci.counts.failing}✗ ${status.ci.counts.pending}⏳)`
            : ''}
        </span>
        {incomplete && (
          <span className="shrink-0 text-fg-muted" title="CI data is incomplete or unknown; do not treat as passing">
            incomplete
          </span>
        )}
        {status.error && (
          <span className="shrink-0 text-warn" title={status.error}>
            {status.error}
          </span>
        )}
        {stale ? (
          <span role="status" className="shrink-0 text-fg-muted">
            outdated{age ? ` · ${age}` : ''}
          </span>
        ) : age ? (
          <span className="shrink-0 text-fg-muted">{age}</span>
        ) : null}
        {hasChecks && (
          <button
            type="button"
            aria-expanded={checksOpen}
            onClick={() => setChecksOpen((o) => !o)}
            className="shrink-0 cursor-pointer select-none whitespace-nowrap text-fg-muted hover:text-fg"
          >
            {checksOpen ? '▾' : '▸'} Checks ({status.ci!.checks.length}) @ {status.ci!.commitOid.slice(0, 7)}
          </button>
        )}
      </div>
      {checksOpen && hasChecks && <CheckList ci={status.ci!} />}
    </div>
  )
}

function PrChip({ pr, stale }: { pr: PullRequestInfo; stale: boolean }) {
  const review = REVIEW_LABEL[pr.review]
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 font-medium whitespace-nowrap text-accent hover:underline ${
        stale ? 'border border-dashed border-line' : ''
      }`}
      title={`${pr.title} · ${pr.headRepository}@${pr.headOid.slice(0, 7)} → ${pr.baseRepository}/${pr.baseBranch}`}
    >
      <span>
        PR #{pr.number} · {PR_LABEL[pr.state]}
      </span>
      {review && (
        <span
          className={`shrink-0 ${
            pr.review === 'approved' ? 'text-ok' : pr.review === 'changes_requested' ? 'text-err' : 'text-fg-muted'
          }`}
        >
          {review}
        </span>
      )}
      <span aria-hidden className="shrink-0">
        ↗
      </span>
    </a>
  )
}

function CheckList({ ci }: { ci: CiSummary }) {
  return (
    <ul className="mt-1 space-y-0.5 text-[11px]">
      {ci.checks.map((check, i) => (
        <li key={`${check.name}-${i}`} className="flex items-center gap-1.5">
          <span aria-hidden className={`w-2 shrink-0 text-center ${CI_CLASS[check.state].split(' ')[1]}`}>
            {check.state === 'passing' ? '✓' : check.state === 'failing' ? '✗' : check.state === 'pending' ? '◌' : '?'}
          </span>
          {check.url ? (
            <a href={check.url} target="_blank" rel="noopener noreferrer" className="truncate text-accent hover:underline">
              {check.name}
            </a>
          ) : (
            <span className="truncate text-fg-muted">{check.name}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
