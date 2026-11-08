import { readFile } from 'node:fs/promises'
import { run } from '../exec.js'
import { BOUNDS } from '../config.js'
import { parseDiff, type ParsedFile } from '../hunks.js'

export interface RepoStatus {
  branch: string | null
  /** HEAD sha (or descriptor like '(rebase)') from branch.oid. */
  oid: string
  unborn: boolean
  hasStaged: boolean
  hasUnstaged: boolean
  ahead: number
  behind: number
  /** True when porcelain reported `# branch.ab`, i.e. an upstream is set. */
  hasUpstream: boolean
  untracked: string[]
  /** Tracked files with worktree-side changes not fully staged. */
  unstaged: string[]
  /** Unmerged paths. */
  conflicts: string[]
}

export interface DiffResult {
  files: ParsedFile[]
  truncated: boolean
}

/**
 * Extract XY codes and the (first) path from a porcelain v2 entry line.
 * '1': kind XY sub m1 m2 m3 s1 s2 path (6 after XY).
 * '2': + Xscore + path:dst (7 after XY).
 * 'u': sub + 4 modes + 3 shas + path (8 after XY).
 * Git C-quotes special paths ("…"); common escapes are undone.
 */
function entryFields(line: string): { xy: string; path: string } | null {
  const kind = line[0]
  if (kind !== '1' && kind !== '2' && kind !== 'u') return null
  const fieldsAfterXy = kind === '1' ? 6 : kind === '2' ? 7 : 8
  const re = new RegExp(`^${kind} (\\S{2}) (?:\\S+ ){${fieldsAfterXy}}(.+)$`)
  const m = re.exec(line)
  if (!m) return null
  let path = m[2]!
  if (kind === '2') {
    const sep = path.indexOf(': ')
    if (sep > 0) path = path.slice(0, sep)
  }
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return { xy: m[1]!, path }
}

/** Per-repository git facts computed locally; replaces the fragile upstream `status --all --git`. */
export async function repoStatus(cwd: string): Promise<RepoStatus> {
  const res = await run(['git', 'status', '--porcelain=v2', '--branch', '-uall'], { cwd })
  if (res.code !== 0) {
    throw new Error(`git status failed in ${cwd}: ${res.stderr.trim() || `exit ${res.code}`}`)
  }
  const status: RepoStatus = {
    branch: null,
    oid: '',
    unborn: false,
    hasStaged: false,
    hasUnstaged: false,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    untracked: [],
    unstaged: [],
    conflicts: [],
  }
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      status.oid = line.slice(12).trim()
      if (line.slice(12).trim() === '(rebase)' || line.includes('unborn')) status.unborn = true
      const oid = line.slice(12).trim()
      if (oid.startsWith('(')) status.unborn = true
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice(13).trim()
      status.branch = head === '(detached)' || head.startsWith('(') ? head : head
    } else if (line.startsWith('# branch.ab ')) {
      status.hasUpstream = true
      const [, ahead, behind] = line.slice(10).split(' ')
      status.ahead = Number(ahead ?? 0)
      status.behind = Math.abs(Number(behind ?? 0))
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const entry = entryFields(line)
      if (!entry) continue
      const { xy, path } = entry
      if (xy[0] !== '.') status.hasStaged = true
      if (xy[1] !== '.') status.hasUnstaged = true
      if (line.startsWith('u ')) {
        status.hasStaged = true
        status.conflicts.push(path)
      } else if (xy[1] !== '.') {
        status.unstaged.push(path)
      }
    } else if (line.startsWith('? ')) {
      status.untracked.push(line.slice(2))
    }
  }
  return status
}

export async function isRepo(cwd: string): Promise<boolean> {
  const res = await run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd })
  return res.code === 0
}

export async function hasHead(cwd: string): Promise<boolean> {
  const res = await run(['git', 'rev-parse', '--verify', 'HEAD'], { cwd })
  return res.code === 0
}

/** Uncommitted tracked changes (staged + unstaged) against HEAD. */
export async function diffWip(cwd: string): Promise<DiffResult> {
  if (!(await hasHead(cwd))) return { files: [], truncated: false }
  return diffArgs(cwd, ['diff', 'HEAD', '--no-color', '--unified=3', '--no-ext-diff'])
}

/** Branch changes vs base using merge-base semantics. */
export async function diffBranch(cwd: string, base: string): Promise<DiffResult> {
  return diffArgs(cwd, ['diff', `${base}...HEAD`, '--no-color', '--unified=3', '--no-ext-diff'])
}

async function diffArgs(cwd: string, args: string[]): Promise<DiffResult> {
  const res = await run(['git', ...args], { cwd, timeoutMs: BOUNDS.mergeTimeoutMs })
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${res.stderr.trim() || `exit ${res.code}`}`)
  }
  const truncated = res.stdout.length > BOUNDS.maxDiffBytes
  const text = truncated ? res.stdout.slice(0, BOUNDS.maxDiffBytes) : res.stdout
  return { files: parseDiff(text), truncated }
}

/** Apply a patch built from a single hunk to the index (stage) or reverse it (unstage). */
export async function applyToIndex(
  cwd: string,
  patch: string,
  opts: { reverse?: boolean } = {},
): Promise<{ ok: boolean; error: string | null }> {
  const args = ['apply', '--cached', '--whitespace=nowarn']
  if (opts.reverse) args.push('-R')
  const res = await run(['git', ...args, '-'], { cwd, input: patch })
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || `git apply exit ${res.code}` }
  }
  return { ok: true, error: null }
}

/** Stage exact paths (validated by the caller) untracked or unstaged alike. */
export async function addPaths(cwd: string, paths: string[]): Promise<void> {
  const res = await run(['git', 'add', '--', ...paths], { cwd })
  if (res.code !== 0) {
    throw new Error(`git add failed in ${cwd}: ${res.stderr.trim() || `exit ${res.code}`}`)
  }
}

export interface CommitRun {
  code: number
  stdout: string
  stderr: string
}

/** Run the operator-configured commit argv in the worktree. */
export async function runCommit(cwd: string, argv: string[], timeoutMs: number): Promise<CommitRun> {
  const res = await run(argv, { cwd, timeoutMs })
  return { code: res.code, stdout: res.stdout, stderr: res.stderr }
}

/** Run a configured push command (argv from buildPushArgv) in the worktree. */
export async function runPush(cwd: string, argv: string[], timeoutMs: number): Promise<CommitRun> {
  const res = await run(argv, { cwd, timeoutMs })
  return { code: res.code, stdout: res.stdout, stderr: res.stderr }
}

/** Resolve base branch: .workmux.yaml base_branch, then origin/HEAD, else null. */
export async function resolveBase(cwd: string): Promise<string | null> {
  const yaml = await readWorkmuxBase(cwd)
  if (yaml && yaml !== 'auto') return yaml
  const originHead = await run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd })
  if (originHead.code === 0) {
    const short = originHead.stdout.trim().replace(/^origin\//, '')
    if (short) return short
  }
  if (yaml === 'auto') {
    for (const candidate of ['main', 'master']) {
      const exists = await run(['git', 'rev-parse', '--verify', `refs/heads/${candidate}`], { cwd })
      if (exists.code === 0) return candidate
    }
  }
  return null
}

// Revision names must not look like options and must start alnum; guards
// against argv option injection via repo-controlled .workmux.yaml values.
export const SAFE_REV = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

async function readWorkmuxBase(cwd: string): Promise<string | null> {
  for (const name of ['.workmux.yaml', '.workmux.yml']) {
    try {
      const text = await readFile(`${cwd}/${name}`, 'utf8')
      const m = /^base_branch:\s*["']?([\w./-]+)["']?\s*(?:#.*)?$/m.exec(text)
      if (m?.[1] && SAFE_REV.test(m[1])) return m[1]
    } catch {
      // missing config is normal
    }
  }
  return null
}

/** gh CLI present on PATH. */
export async function ghAvailable(): Promise<boolean> {
  const res = await run(['gh', '--version']).catch(() => null)
  return res !== null && res.code === 0
}

/** PR URL via gh CLI when available; null otherwise. */
export async function prUrl(cwd: string, branch: string): Promise<string | null> {
  try {
    const res = await run(['gh', 'pr', 'view', '--json', 'url', '--jq', '.url', '--head', branch], { cwd })
    const url = res.stdout.trim()
    return res.code === 0 && /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

export interface CommitEntry {
  sha: string
  subject: string
  /** Full message body (after the subject); capped, may be empty. */
  body: string
}

export interface UnpushedResult {
  commits: CommitEntry[]
  truncated: boolean
  /** Range label the commits are ahead of; null for first push. */
  ref: string | null
}

/** `origin` remote configured. */
export async function hasOrigin(cwd: string): Promise<boolean> {
  const res = await run(['git', 'remote', 'get-url', 'origin'], { cwd }).catch(() => null)
  return res !== null && res.code === 0
}

/**
 * Commits on HEAD not present on the remote-tracking branch (newest first,
 * capped at limit). Uses upstream when set, else origin/<branch> when that
 * remote ref exists, else all of HEAD (first push).
 */
export async function unpushedCommits(
  cwd: string,
  branch: string,
  limit: number,
): Promise<UnpushedResult> {
  let ref: string | null = null
  const up = await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd })
  if (up.code === 0 && up.stdout.trim() !== '') {
    ref = up.stdout.trim()
  } else if (SAFE_REV.test(branch)) {
    const remoteRef = await run(['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd })
    if (remoteRef.code === 0) ref = `origin/${branch}`
  }
  const range = ref ? `${ref}..HEAD` : 'HEAD'
  const res = await run(
    ['git', 'log', `-${limit + 1}`, '--pretty=format:%h%x09%s%x09%b%x1e', range],
    { cwd },
  )
  if (res.code !== 0) return { commits: [], truncated: false, ref }
  const records = res.stdout.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r !== '')
  const truncated = records.length > limit
  const commits = records.slice(0, limit).map((rec) => {
    const [sha = '', subject = '', ...rest] = rec.split('\t')
    const body = rest.join('\t').replace(/^\n+/, '').replace(/\s+$/, '')
    return {
      sha,
      subject,
      body: body.slice(0, BOUNDS.maxPushCommitBodyBytes),
    }
  })
  return { commits, truncated, ref }
}

/**
 * Push current branch. First push (no upstream) runs `push -u origin
 * <branch>`; otherwise plain `git push`. NEVER any force variant — a
 * non-fast-forward is rejected by the remote and surfaced as an error.
 */
export async function push(
  cwd: string,
  branch: string,
  setUpstream: boolean,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = setUpstream ? ['git', 'push', '-u', 'origin', branch] : ['git', 'push']
  const res = await run(argv, { cwd, timeoutMs })
  return { code: res.code, stdout: res.stdout, stderr: res.stderr }
}
