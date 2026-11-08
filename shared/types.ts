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
  /** Commits ahead of upstream (unpushed). Null = no upstream configured. */
  ahead: number | null
  /** Commits behind upstream. Null = no upstream configured. */
  behind: number | null
  /** Distinct files with pending changes (untracked+staged+unstaged+conflicts). */
  pendingChanges?: number | null
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
  /** Unpushed commit count (ahead of upstream). Null = no upstream / no git info. */
  unpushed: number | null
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

export type DiffMode = 'wip' | 'branch'

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
