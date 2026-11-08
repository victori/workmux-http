import type {
  AddResult,
  CommitAccepted,
  CreateWorktreeRequest,
  DashboardSnapshot,
  DeliveryResult,
  DiffMode,
  DiffResponse,
  HealthResponse,
  HunkAction,
  HunkActionResult,
  KeyName,
  OperationView,
  PrepareActionRequest,
  PreparedAction,
  ProjectInfo,
  OutputResponse,
} from '@shared/types'

export const MUTATION_HEADER = { 'x-workmux-request': '1' }

/**
 * requestId for mutation dedupe. crypto.randomUUID is gated to secure
 * contexts; the dashboard runs over plain http on a LAN/VPN address from
 * the phone, where Safari leaves it undefined — fall back to a unique
 * time+random id (dedupe only needs uniqueness, not entropy quality).
 */
export function newRequestId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined
  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      /* non-secure context throw — fall through */
    }
  }
  const rnd = () => Math.random().toString(36).slice(2, 10)
  return `r-${Date.now().toString(36)}-${rnd()}${rnd()}`
}

export class ApiError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `http ${status}`))
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

/**
 * Reads carry a deadline (audit F11): a stalled proxy/network must not
 * freeze polling forever. Mutations deliberately have NO deadline — aborting
 * a possibly-applied mutation would fake an "unknown delivery" the server
 * never reported; hangs there resolve via their own timeouts.
 */
const READ_TIMEOUT_MS = 15000

function get<T>(path: string): Promise<T> {
  return request<T>(path, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...MUTATION_HEADER },
    body: JSON.stringify(body),
  })
}

export function encodeId(id: string): string {
  return encodeURIComponent(id)
}

export const api = {
  health: () => get<HealthResponse>('/api/health'),
  dashboard: (force = false) => get<DashboardSnapshot>(`/api/dashboard${force ? '?force=1' : ''}`),
  projects: () => get<ProjectInfo[]>('/api/projects'),
  output: (agentId: string, lines?: number) =>
    get<OutputResponse>(`/api/agents/${encodeId(agentId)}/output${lines ? `?lines=${lines}` : ''}`),
  message: (agentId: string, text: string, requestId: string) =>
    post<DeliveryResult>(`/api/agents/${encodeId(agentId)}/messages`, { text, requestId }),
  keys: (agentId: string, keys: KeyName[], requestId: string) =>
    post<DeliveryResult>(`/api/agents/${encodeId(agentId)}/keys`, { keys, requestId }),
  diff: (worktreeId: string, mode: DiffMode) =>
    get<DiffResponse>(`/api/worktrees/${encodeId(worktreeId)}/diff?mode=${mode}`),
  hunkAction: (worktreeId: string, action: HunkAction, req: unknown) =>
    post<HunkActionResult>(`/api/worktrees/${encodeId(worktreeId)}/hunks/${action}`, req),
  hunkComment: (worktreeId: string, req: unknown) =>
    post<DeliveryResult>(`/api/worktrees/${encodeId(worktreeId)}/hunk-comments`, req),
  addPaths: (worktreeId: string, paths: string[]) =>
    post<AddResult>(`/api/worktrees/${encodeId(worktreeId)}/add`, { paths }),
  unstagePaths: (worktreeId: string, paths: string[]) =>
    post<AddResult>(`/api/worktrees/${encodeId(worktreeId)}/unstage`, { paths }),
  commit: (worktreeId: string, message?: string) =>
    post<CommitAccepted>(`/api/worktrees/${encodeId(worktreeId)}/commit`, { message }),
  createWorktree: (req: CreateWorktreeRequest) => post<OperationView>('/api/worktrees', req),
  prepare: (req: PrepareActionRequest) => post<PreparedAction>('/api/actions/prepare', req),
  execute: (req: PrepareActionRequest & { confirmToken: string; requestId: string }) =>
    post<OperationView>('/api/actions/execute', req),
  operation: (id: string) => get<OperationView>(`/api/operations/${encodeId(id)}`),
}

export function terminalWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api/terminal`
}
