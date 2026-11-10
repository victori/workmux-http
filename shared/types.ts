export type AgentStatus = 'working' | 'waiting' | 'done' | 'stale'

export type SortMode = 'priority' | 'project' | 'recency' | 'natural'

export type SourceState =
  | { ok: true; at: number }
  | { ok: false; error: string; at: number }

export interface GitInfo {
  branch: string | null
  hasStaged: boolean
  hasUnstaged: boolean
  hasUnmergedCommits: boolean
  unborn: boolean
  /** Commits ahead of upstream (unpushed). Null = no upstream and no origin/<branch> ref. */
  ahead: number | null
  /** Commits behind upstream. Null = no upstream and no origin/<branch> ref. */
  behind: number | null
  /** Distinct files with pending changes (untracked+staged+unstaged+conflicts). */
  pendingChanges?: number | null
  /** HEAD oid from porcelain branch.oid; null when unborn/unresolvable. */
  headOid?: string | null
  unavailable?: undefined
}

export interface AgentView {
  /** Stable tmux pane id, e.g. "%286". Server-scoped opaque handle for agents. */
  id: string
  name: string
  project: string
  projectPath: string
  /** Opaque server-issued worktree id. */
  worktreeId: string
  status: AgentStatus
  elapsedSecs: number
  title: string | null
  agentKind: string | null
  session: string
  windowName: string | null
  workdir: string
  git: GitInfo | null
  updatedTs: number
}

export interface WorktreeView {
  /** Opaque server-issued id (hash of project + path). */
  id: string
  project: string
  projectPath: string
  handle: string
  branch: string
  path: string
  isMain: boolean
  mode: 'window' | 'session'
  hasUncommittedChanges: boolean
  isOpen: boolean
  agentStatuses: AgentStatus[]
  createdAt: number
  prUrl: string | null
  /** GitHub PR/CI enrichment for this worktree; absent = never attempted. */
  github?: GithubStatus
  /** Unpushed commit count (ahead of upstream or origin/<branch>). Null = unknown / no git info. */
  unpushed: number | null
}

export type CiState = 'none' | 'pending' | 'passing' | 'failing' | 'neutral' | 'unknown'

export interface CiSummary {
  state: CiState
  commitOid: string
  /** False when pagination was exhausted or data was partial. */
  complete: boolean
  counts: { passing: number; failing: number; pending: number; neutral: number; unknown: number }
  checks: Array<{ name: string; state: CiState; url: string | null }>
}

export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  review: 'approved' | 'changes_requested' | 'review_required' | 'unknown'
  headOid: string
  headRepository: string
  baseRepository: string
  baseBranch: string
}

/**
 * GitHub PR/CI view. `ready` + `pr: null` = a complete successful query
 * found no matching PR; `unavailable`/`stale`/`unsupported` are never
 * evidence of absence or passing CI.
 */
export interface GithubStatus {
  state: 'loading' | 'ready' | 'stale' | 'unavailable' | 'unsupported'
  pr: PullRequestInfo | null
  ci: CiSummary | null
  observedAt: number | null
  attemptedAt: number | null
  error: string | null
}

export interface DashboardSnapshot {
  observedAt: number
  agents: AgentView[]
  worktrees: WorktreeView[]
  sources: {
    workmuxList: SourceState
    workmuxStatus: SourceState
    tmux: SourceState
    git: SourceState
  }
  stale: boolean
}

export interface ProjectInfo {
  name: string
  path: string
  baseBranch: string | null
  agents: string[]
  hasConfig: boolean
}

export interface OutputResponse {
  paneId: string
  text: string
  lines: number
  truncated: boolean
  observedAt: number
}

export type KeyName =
  | 'enter'
  | 'esc'
  | 'tab'
  | 'backtab'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pgup'
  | 'pgdn'
  | 'bspace'
  | 'space'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-u'
  | 'ctrl-a'
  | 'ctrl-e'
  | 'ctrl-l'
  | 'ctrl-r'

export interface MessageRequest {
  text: string
  requestId: string
}

export interface KeysRequest {
  keys: KeyName[]
  requestId: string
}

export interface DeliveryResult {
  delivered: 'sent' | 'unknown'
  requestId: string
  paneId: string
  detail?: string
}

export type DiffMode = 'wip' | 'branch' | 'commit'

/** One commit from git log (newest first). */
export interface CommitInfo {
  sha: string
  short: string
  author: string
  dateSecs: number
  subject: string
  isMerge: boolean
}

export interface CommitListResponse {
  commits: CommitInfo[]
  truncated: boolean
}

export type FileChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'binary'
  | 'untracked'

export interface Hunk {
  index: number
  file: string
  header: string
  oldStart: number
  newStart: number
  oldCount: number
  newCount: number
  splittable: boolean
  text: string
}

export interface DiffFile {
  path: string
  oldPath?: string
  status: FileChangeStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: Hunk[]
  diff: string
}

export interface DiffResponse {
  worktreeId: string
  mode: DiffMode
  base: string | null
  /** Present in commit mode: the commit whose diff is shown. */
  commit?: CommitInfo
  /** Set when branch mode cannot resolve a configured base branch. */
  baseMissing: boolean
  unborn: boolean
  snapshotId: string
  files: DiffFile[]
  untracked: string[]
  /** Tracked files with worktree-side changes not fully staged. */
  unstaged: string[]
  /** Paths with index changes vs HEAD (staged; conflicts excluded). */
  staged: string[]
  /** Unmerged paths; addable only after conflict resolution. */
  conflicts: string[]
  hasStaged: boolean
  /** False when git status could not be read; pending lists are then unknown, not empty. */
  pendingKnown: boolean
  /** Resolved commit command for this worktree's agent kind; null keeps agent commit. */
  commitCmd: string | null
  truncated: boolean
  observedAt: number
}

export interface AddRequest {
  paths: string[]
}

export interface AddResult {
  ok: boolean
  message?: string
  /** Paths no longer pending on the server (client should refresh). */
  offenders?: string[]
}

export interface CommitRequest {
  /** Optional; empty/omitted = the commit command runs with no message arg. */
  message?: string
}

export interface CommitAccepted {
  operationId: string
}

export type HunkAction = 'stage' | 'unstage' | 'split'

export interface HunkActionRequest {
  snapshotId: string
  file: string
  hunkIndex: number
  /** Sub-hunk pieces after split; split returns these instead of applying. */
  piece?: string
  comment?: string
}

export interface HunkActionResult {
  ok: boolean
  snapshotStale: boolean
  message?: string
  pieces?: string[]
}

export type ActionType = 'merge' | 'remove' | 'stop' | 'close' | 'open' | 'push'

export interface PrepareActionRequest {
  action: ActionType
  targetId: string
  /** User acknowledged warnings (e.g. discard uncommitted changes). */
  acceptWarnings?: boolean
}

export interface PreparedAction {
  action: ActionType
  targetId: string
  targetLabel: string
  requiresConfirmation: true
  /** Server-issued token bound to exact action+target+warning state (absent on server-side revalidation). */
  confirmToken?: string
  warnings: string[]
  /** For 'push': commits that would be published, newest first (capped). */
  commits?: Array<{ sha: string; subject: string; body?: string }>
  /** True when the commits list was truncated at the cap. */
  commitsTruncated?: boolean
  /** Reason the action cannot run even with confirmation. */
  blocked?: string
}

export interface ExecuteActionRequest extends PrepareActionRequest {
  /** Must equal the prepare response token bound to exact action+target+state. */
  confirmToken: string
  requestId: string
}

export interface OperationView {
  id: string
  kind: string
  target: string
  state: 'running' | 'done' | 'failed' | 'unknown'
  output: string | null
  error: string | null
  /** Structured outcome for kinds that produce one (sweep, sweep_scan). */
  result?: OperationResult
  startedAt: number
  endedAt: number | null
}

export interface CreateWorktreeRequest {
  project: string
  name: string
  prompt?: string
  agent?: string
  baseBranch?: string
  requestId: string
}

export type SweepReason = 'pr_merged' | 'pr_closed' | 'upstream_gone' | 'merged_locally'

export interface SweepCandidate {
  worktreeId: string
  targetLabel: string
  branch: string
  path: string
  /** Null when blockers prevent any cleanup reason. */
  reason: SweepReason | null
  blockers: string[]
  warnings: string[]
}

/** Typed scan result carried by a completed sweep_scan operation. */
export interface SweepScan {
  type: 'sweep_scan'
  candidates: SweepCandidate[]
  expiresAt: number
}

export interface SweepItem {
  worktreeId: string
  targetLabel: string
  state: 'pending' | 'running' | 'removed' | 'skipped' | 'failed' | 'unknown'
  message: string | null
}

/** Typed per-item outcome carried by a completed sweep operation. */
export interface SweepResult { type: 'sweep'; items: SweepItem[] }

export type OperationResult = SweepScan | SweepResult

export interface SweepScanRequest {
  worktreeIds: string[]
  requestId: string
}

export interface SweepPrepareRequest {
  scanId: string
  worktreeIds: string[]
  keepBranches: boolean
  requestId: string
}

export interface PreparedSweep {
  confirmToken: string
  expiresAt: number
  targets: SweepCandidate[]
  keepBranches: boolean
  warnings: string[]
}

export interface SweepExecuteRequest {
  confirmToken: string
  acceptWarnings: boolean
  requestId: string
}

export interface HealthResponse {
  ok: boolean
  workmuxVersion: string | null
  tmuxSocket: string | null
  tmuxReachable: boolean
  workmuxReachable: boolean
  fixtureMode: boolean
  ownedTerminalSessions: string[]
  checkedAt: number
  error?: string
}

export interface ApiErrorBody {
  error: string
  detail?: string
}

/** WS /api/terminal client -> server messages */
export type TerminalClientMessage =
  | { type: 'attach'; agentId: string; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'fit'; cols: number; rows: number }
  | { type: 'detach' }

/** WS /api/terminal server -> client messages */
export type TerminalServerMessage =
  | {
      type: 'attached'
      agentId: string
      sessionId: string
      cols: number
      rows: number
      /** Pane tmux actually focuses in the attached window; may differ from the requested agent (full-session access, disclosed). Absent = unknown. */
      activePaneId?: string | null
    }
  | { type: 'output'; data: string }
  | { type: 'resized'; cols: number; rows: number }
  /** The window's active pane changed while attached; keystrokes follow it. */
  | { type: 'pane-changed'; activePaneId: string }
  | { type: 'detached'; reason: string }
  | { type: 'error'; error: string }
