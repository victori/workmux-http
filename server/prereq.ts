import { run } from './exec.js'
import type { RunResult } from './exec.js'

/**
 * Startup prerequisite probes. Missing required tools are surfaced as
 * warnings (the server still boots — health endpoints keep reporting the
 * degraded sources), optional tools as notes.
 */

const PROBE_TIMEOUT_MS = 5000
const MIN_TMUX: [number, number] = [3, 2]
const MIN_GIT: [number, number] = [2, 11]

export type PrereqLevel = 'warn' | 'info'

export interface PrereqIssue {
  tool: string
  level: PrereqLevel
  message: string
}

export type PrereqRunner = (argv: string[], opts: { timeoutMs: number }) => Promise<RunResult>

function parseVersion(text: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(text)
  const major = m?.[1]
  const minor = m?.[2]
  if (major === undefined || minor === undefined) return null
  return [Number(major), Number(minor)]
}

function atLeast(v: [number, number], min: [number, number]): boolean {
  return v[0] > min[0] || (v[0] === min[0] && v[1] >= min[1])
}

async function probe(runner: PrereqRunner, argv: string[]): Promise<RunResult | null> {
  try {
    return await runner(argv, { timeoutMs: PROBE_TIMEOUT_MS })
  } catch {
    return null
  }
}

/** Probe PATH tools; empty when fixture mode makes external binaries irrelevant. */
export async function checkPrerequisites(opts: {
  fixtureMode: boolean
  runner?: PrereqRunner
}): Promise<PrereqIssue[]> {
  if (opts.fixtureMode) return []
  const runner = opts.runner ?? run
  const issues: PrereqIssue[] = []

  const tmux = await probe(runner, ['tmux', '-V'])
  if (!tmux || tmux.code !== 0) {
    issues.push({ tool: 'tmux', level: 'warn', message: 'not found on PATH (required) — no sessions, panes, or message delivery; see README Prerequisites' })
  } else {
    const v = parseVersion(tmux.stdout)
    if (v && !atLeast(v, MIN_TMUX)) {
      issues.push({ tool: `tmux ${v.join('.')}`, level: 'warn', message: 'older than 3.2 — sending messages (paste-buffer -p) will fail; upgrade tmux' })
    }
  }

  const workmux = await probe(runner, ['workmux', '--version'])
  if (!workmux || workmux.code !== 0) {
    issues.push({ tool: 'workmux', level: 'warn', message: 'not found on PATH (required) — agent/worktree discovery will report dependency_error' })
  }

  const git = await probe(runner, ['git', '--version'])
  if (!git || git.code !== 0) {
    issues.push({ tool: 'git', level: 'warn', message: 'not found on PATH (required) — status, diffs, staging, merge, and push are unavailable' })
  } else {
    const v = parseVersion(git.stdout)
    if (v && !atLeast(v, MIN_GIT)) {
      issues.push({ tool: `git ${v.join('.')}`, level: 'warn', message: 'older than 2.11 — porcelain v2 status is unsupported; upgrade git' })
    }
  }

  const gh = await probe(runner, ['gh', '--version'])
  if (!gh || gh.code !== 0) {
    issues.push({ tool: 'gh', level: 'info', message: 'not found — GitHub PR/CI status stays disabled (optional)' })
  } else {
    const auth = await probe(runner, ['gh', 'auth', 'status'])
    if (!auth || auth.code !== 0) {
      issues.push({ tool: 'gh', level: 'warn', message: 'installed but not authenticated — run `gh auth login`; PR/CI status stays unavailable' })
    }
  }

  return issues
}

export function formatPrereqIssue(issue: PrereqIssue): string {
  return issue.level === 'warn'
    ? `WARNING: ${issue.tool}: ${issue.message}`
    : `note: ${issue.tool}: ${issue.message}`
}
