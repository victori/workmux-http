import os from 'node:os'

export interface AppConfig {
  bind: string
  port: number
  /** null = resolve from default tmux server at startup. */
  tmuxSocket: string | null
  /** Extra repository paths supplementing tracked-project discovery. */
  repos: string[]
  allowedHosts: string[]
  /** WORKMUX_ALLOWED_HOSTS='*': accepts any Host header. DNS-rebinding exposed — no login behind it. */
  allowAnyHost: boolean
  /** Directory with sanitized JSON fixtures; bypasses live workmux/tmux (e2e only). */
  fixtureDir: string | null
  staleAfterSecs: number
  maxOwnedTerminals: number
  /** Timeout for the configurable commit command (WORKMUX_COMMIT_TIMEOUT_MS). */
  commitTimeoutMs: number
  pushTimeoutMs: number
  /**
   * Commit command per agent kind, from WORKMUX_<KIND>_COMMIT_CMD
   * (kind uppercased, non-alphanumerics → `_`), e.g.
   * WORKMUX_OMP_COMMIT_CMD='opencode-commit'. OMP and OPENCODE are
   * interchangeable spellings of the same agent. Undefined = no shell
   * commit for that kind; the UI keeps the agent-commit path.
   */
  commitCmdFor: (kind: string | null) => string | null
  pushCmdFor: (kind: string | null) => string | null
}

const DEFAULT_STALE_AFTER_SECS = 3600
const DEFAULT_MAX_OWNED_TERMINALS = 4
const DEFAULT_COMMIT_TIMEOUT_MS = 300000
const DEFAULT_PUSH_TIMEOUT_MS = 120000

/** Interchangeable agent-kind spellings (workmux reports opencode as `omp`). */
const KIND_ALIASES: Record<string, string[]> = {
  OMP: ['OMP', 'OPENCODE'],
  OPENCODE: ['OPENCODE', 'OMP'],
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.WORKMUX_HTTP_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid WORKMUX_HTTP_PORT: ${env.WORKMUX_HTTP_PORT}`)
  }
  const bind = env.WORKMUX_HTTP_BIND ?? '127.0.0.1'
  if ((bind === '0.0.0.0' || bind === '::') && env.WORKMUX_HTTP_ALLOW_WILDCARD !== '1') {
    throw new Error(
      'refusing wildcard bind; set WORKMUX_HTTP_BIND to a loopback or VPN interface address, ' +
        'or set WORKMUX_HTTP_ALLOW_WILDCARD=1 to opt in (then WORKMUX_ALLOWED_HOSTS MUST list every ' +
        'IP/hostname you access it by, or all requests get 403 forbidden_host)',
    )
  }
  return {
    bind,
    port,
    tmuxSocket: env.WORKMUX_TMUX_SOCKET || null,
    repos: (env.WORKMUX_REPOS ?? '')
      .split(':')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => (p === '~' ? os.homedir() : p.replace(/^~\//, `${os.homedir()}/`))),
    allowedHosts: (env.WORKMUX_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '' && s !== '*'),
    allowAnyHost: (env.WORKMUX_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .includes('*'),
    fixtureDir: env.WORKMUX_HTTP_FIXTURES || null,
    staleAfterSecs: Number(env.WORKMUX_HTTP_STALE_AFTER ?? DEFAULT_STALE_AFTER_SECS),
    maxOwnedTerminals: Number(env.WORKMUX_HTTP_MAX_OWNED_TERMINALS ?? DEFAULT_MAX_OWNED_TERMINALS),
    commitTimeoutMs: Number(env.WORKMUX_COMMIT_TIMEOUT_MS ?? DEFAULT_COMMIT_TIMEOUT_MS),
    pushTimeoutMs: Number(env.WORKMUX_PUSH_TIMEOUT_MS ?? DEFAULT_PUSH_TIMEOUT_MS),
    commitCmdFor: (kind) => {
      if (!kind) return null
      const norm = kind.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      for (const alias of KIND_ALIASES[norm] ?? [norm]) {
        const cmd = (env[`WORKMUX_${alias}_COMMIT_CMD`] ?? '').trim()
        if (cmd !== '') return cmd
      }
      return null
    },
    pushCmdFor: (kind) => {
      if (!kind) return null
      const norm = kind.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      for (const alias of KIND_ALIASES[norm] ?? [norm]) {
        const cmd = (env[`WORKMUX_${alias}_PUSH_CMD`] ?? '').trim()
        if (cmd !== '') return cmd
      }
      return null
    },
  }
}

export const BOUNDS = {
  coreTtlMs: 2000,
  gitTtlMs: 10000,
  subprocessTimeoutMs: 15000,
  createTimeoutMs: 300000,
  mergeTimeoutMs: 120000,
  maxSubprocessOutputBytes: 4 * 1024 * 1024,
  maxWsMessageBytes: 256 * 1024,
  maxOutputLines: 2000,
  defaultOutputLines: 400,
  maxDiffBytes: 1024 * 1024,
  maxCommits: 200,
  defaultCommits: 50,
  maxHunkCommentChars: 8000,
  dedupTtlMs: 300000,
  dedupMaxEntries: 1000,
  confirmTokenTtlMs: 300000,
  maxCommitMessageBytes: 4096,
  maxAddPaths: 200,
  maxCommitOutputBytes: 4096,
  maxPushCommitsList: 20,
  maxPushCommitBodyBytes: 2000,
  maxRemotesPerRepo: 8,
  githubTimeoutMs: 10000,
  githubJobTimeoutMs: 30000,
  githubPrLimit: 100,
  githubPageSize: 100,
  githubMaxPages: 5,
  githubMaxVisibleChecks: 20,
  githubSuccessTtlMs: 60000,
  githubFailureRetryMs: 15000,
  githubConcurrency: 4,
  githubQueueMax: 100,
  githubCacheMax: 1000,
  sweepScanMaxTargets: 100,
  sweepExecuteMaxTargets: 20,
  sweepMaxActiveScans: 1,
  sweepMaxActiveSweeps: 1,
  sweepScanTtlMs: 300000,
  sweepMaxStoredScans: 20,
  sweepMaxStoredTokens: 100,
}
