import { z } from 'zod'
import { run, type RunError, type RunResult } from '../exec.js'
import { BOUNDS } from '../config.js'

const WorktreeRecordSchema = z.object({
  project: z.string(),
  project_path: z.string(),
  handle: z.string(),
  branch: z.string(),
  path: z.string(),
  is_main: z.boolean(),
  mode: z.enum(['window', 'session']),
  has_uncommitted_changes: z.boolean(),
  is_open: z.boolean(),
  agent_statuses: z.array(z.string()),
  created_at: z.number(),
})

const AgentRecordSchema = z.object({
  worktree: z.string(),
  branch: z.string(),
  // Live payloads can carry null project when the owning repository cannot be
  // resolved; discovery falls back to the workdir basename (workmux's rule).
  project: z.string().nullable(),
  project_path: z.string().nullable(),
  status: z.string(),
  // Live payloads carry null elapsed_secs when timing cannot be computed
  // (e.g. freshly tracked or clock-less state); treat as 0 downstream.
  elapsed_secs: z.number().nullable(),
  title: z.string().nullish(),
  pane_id: z.string().startsWith('%'),
  workdir: z.string(),
  agent_kind: z.string().nullish(),
  session: z.string(),
  window_name: z.string().nullish(),
  updated_ts: z.number(),
  git: z
    .object({
      has_staged: z.boolean(),
      has_unstaged: z.boolean(),
      has_unmerged_commits: z.boolean(),
    })
    .optional(),
})

const StatusPayloadSchema = z.object({
  context: z.object({ backend: z.string(), instance: z.string() }),
  scope: z.unknown(),
  state_files_total: z.number().optional(),
  reconciled_agent_count: z.number().optional(),
  agents: z.array(AgentRecordSchema),
  target_errors: z.array(z.unknown()).optional(),
})

export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>
export type AgentRecord = z.infer<typeof AgentRecordSchema>
export type StatusPayload = z.infer<typeof StatusPayloadSchema>

export class DependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DependencyError'
  }
}

export interface WorkmuxLike {
  version(): Promise<string | null>
  listAll(): Promise<WorktreeRecord[]>
  statusAll(): Promise<StatusPayload>
}

export class Workmux implements WorkmuxLike {
  constructor(readonly bin = 'workmux') {}

  async version(): Promise<string | null> {
    try {
      const res = await run([this.bin, '--version'])
      return res.code === 0 ? res.stdout.trim().replace(/^workmux\s+/, '') : null
    } catch {
      return null
    }
  }

  /** `workmux list --all --json`: worktrees across repositories with tracked agents. */
  async listAll(): Promise<WorktreeRecord[]> {
    const res = await this.exec([this.bin, 'list', '--all', '--json'])
    if (res.code !== 0) {
      throw new DependencyError(`workmux list failed (exit ${res.code}): ${res.stderr.trim()}`)
    }
    return parseJson(res.stdout, z.array(WorktreeRecordSchema), 'workmux list')
  }

  /**
   * `workmux status --all --json`: tracked agents with pane identity.
   * Note: the `--git` flag is deliberately not combined with `--all`; upstream
   * aborts the whole payload when any tracked workdir is not a git repository.
   */
  async statusAll(): Promise<StatusPayload> {
    const res = await this.exec([this.bin, 'status', '--all', '--json'])
    if (res.code !== 0) {
      throw new DependencyError(`workmux status failed (exit ${res.code}): ${res.stderr.trim()}`)
    }
    return parseJson(res.stdout, StatusPayloadSchema, 'workmux status')
  }

  /** Known agent names from `workmux add --help`-style config: observed kinds + configured default. */
  async add(opts: {
    cwd: string
    branch: string
    name?: string
    prompt?: string
    agent?: string
    base?: string
    timeoutMs?: number
  }): Promise<RunResult> {
    const argv = [this.bin, 'add', opts.branch, '-b']
    if (opts.name) argv.push('--name', opts.name)
    if (opts.prompt) argv.push('-p', opts.prompt)
    if (opts.agent) argv.push('-a', opts.agent)
    if (opts.base) argv.push('--base', opts.base)
    return this.exec(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? BOUNDS.createTimeoutMs })
  }

  async merge(opts: { cwd: string; name: string; into?: string; ignoreUncommitted?: boolean }): Promise<RunResult> {
    const argv = [this.bin, 'merge', opts.name]
    if (opts.into) argv.push('--into', opts.into)
    if (opts.ignoreUncommitted) argv.push('--ignore-uncommitted')
    return this.exec(argv, { cwd: opts.cwd, timeoutMs: BOUNDS.mergeTimeoutMs })
  }

  async remove(opts: { cwd: string; name: string; force?: boolean; keepBranch?: boolean }): Promise<RunResult> {
    const argv = [this.bin, 'remove', opts.name]
    if (opts.force) argv.push('-f')
    if (opts.keepBranch) argv.push('--keep-branch')
    return this.exec(argv, { cwd: opts.cwd })
  }

  async close(opts: { cwd: string; name: string }): Promise<RunResult> {
    return this.exec([this.bin, 'close', opts.name], { cwd: opts.cwd })
  }

  async open(opts: { cwd: string; name: string; background: true }): Promise<RunResult> {
    return this.exec([this.bin, 'open', '--background', opts.name], { cwd: opts.cwd })
  }

  private async exec(
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    try {
      return await run(argv, opts)
    } catch (err) {
      if ((err as RunError).isSpawnFailure) {
        throw new DependencyError(`workmux not found on PATH: ${(err as Error).message}`)
      }
      throw err
    }
  }
}

function parseJson<T>(text: string, schema: z.ZodType<T>, label: string): T {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new DependencyError(`${label}: malformed JSON output`)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new DependencyError(`${label}: unexpected payload shape (${parsed.error.issues[0]?.message ?? 'invalid'})`)
  }
  return parsed.data
}
