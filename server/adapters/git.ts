import { readFile } from 'node:fs/promises'
import { run } from '../exec.js'
import { BOUNDS } from '../config.js'
import { parseDiff, type ParsedFile } from '../hunks.js'
import type { CommitInfo, CommitListResponse, RemoteStatus } from '../../shared/types.js'
import type { GithubRequest } from './github.js'

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
  /** True when ahead/behind were derived from origin/<branch> (no configured upstream). */
  upstreamAssumed: boolean
  untracked: string[]
  /** Tracked files with worktree-side changes not fully staged. */
  unstaged: string[]
  /** Paths with index changes vs HEAD (staged; conflicts excluded). */
  staged: string[]
  /** Unmerged paths. */
  conflicts: string[]
  /** Distinct porcelain file entries (each path counts once). */
  pendingChanges: number
}

export interface DiffResult {
  files: ParsedFile[]
  truncated: boolean
}

/**
 * Parse porcelain v2 fields from a record (NUL-delimited with -z, so paths
 * are raw bytes — no C-quoting fidelity loss, audit F10). Path is the
 * remainder after the fixed field count; rename/copy destination kept,
 * source (next record) dropped.
 * '1': kind XY sub m1 m2 m3 s1 s2 path.
 * '2': + Xscore + path (source follows as its own record).
 * 'u': sub + 4 modes + 3 shas + path.
 */
function entryFields(record: string): { xy: string; path: string } | null {
  const kind = record[0]
  if (kind !== '1' && kind !== '2' && kind !== 'u') return null
  const fieldsAfterXy = kind === '1' ? 6 : kind === '2' ? 7 : 8
  const re = new RegExp(`^${kind} (\\S{2}) (?:\\S+ ){${fieldsAfterXy}}(.+)$`, 's')
  const m = re.exec(record)
  if (!m) return null
  return { xy: m[1]!, path: m[2]! }
}

/** Per-repository git facts computed locally; replaces the fragile upstream `status --all --git`. */
export async function repoStatus(cwd: string): Promise<RepoStatus> {
  const res = await run(['git', 'status', '--porcelain=v2', '-z', '--branch', '-uall'], { cwd })
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
    upstreamAssumed: false,
    untracked: [],
    unstaged: [],
    staged: [],
    conflicts: [],
    pendingChanges: 0,
  }
  const records = res.stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (!rec) continue
    if (rec.startsWith('# branch.oid ')) {
      const oid = rec.slice(12).trim()
      status.oid = oid
      if (oid.startsWith('(')) status.unborn = true
    } else if (rec.startsWith('# branch.head ')) {
      const head = rec.slice(13).trim()
      status.branch = head === '(detached)' || head.startsWith('(') ? head : head
    } else if (rec.startsWith('# branch.ab ')) {
      status.hasUpstream = true
      const [, ahead, behind] = rec.slice(10).split(' ')
      status.ahead = Number(ahead ?? 0)
      status.behind = Math.abs(Number(behind ?? 0))
    } else if (rec.startsWith('1 ') || rec.startsWith('2 ') || rec.startsWith('u ')) {
      const entry = entryFields(rec)
      if (!entry) continue
      // Rename/copy: the source path is the NEXT record; destination stands.
      if (rec.startsWith('2 ')) i += 1
      status.pendingChanges += 1
      const { xy, path } = entry
      if (xy[0] !== '.') {
        status.hasStaged = true
        if (!rec.startsWith('u ')) status.staged.push(path)
      }
      if (xy[1] !== '.') status.hasUnstaged = true
      if (rec.startsWith('u ')) {
        status.hasStaged = true
        status.conflicts.push(path)
      } else if (xy[1] !== '.') {
        status.unstaged.push(path)
      }
    } else if (rec.startsWith('? ')) {
      status.untracked.push(rec.slice(2))
      status.pendingChanges += 1
    }
  }
  // No configured upstream: fall back to origin/<branch> when that remote
  // ref exists (same rule unpushedCommits uses), so unpushed badges work
  // for branches pushed without -u.
  if (!status.hasUpstream && status.branch && !status.unborn && SAFE_REV.test(status.branch)) {
    const remoteRef = `refs/remotes/origin/${status.branch}`
    const hasRef = await run(['git', 'show-ref', '--verify', '--quiet', remoteRef], { cwd })
    if (hasRef.code === 0) {
      const counts = await run(['git', 'rev-list', '--left-right', '--count', `origin/${status.branch}...HEAD`], { cwd })
      const m = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/)
      if (counts.code === 0 && m) {
        status.behind = Number(m[1] ?? 0)
        status.ahead = Number(m[2] ?? 0)
        status.upstreamAssumed = true
      }
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

/** Rev is safe for argv when it passes SAFE_REV and carries no range syntax. */
function isSafeRev(rev: string): boolean {
  return SAFE_REV.test(rev) && !rev.includes('..')
}

/** Commit metadata for one rev (null when the rev does not resolve). */
export async function commitInfo(cwd: string, sha: string): Promise<CommitInfo | null> {
  if (!isSafeRev(sha)) return null
  const res = await run(
    ['git', 'show', '-s', '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P', sha],
    { cwd },
  )
  if (res.code !== 0) return null
  const f = res.stdout.split('\x1f')
  if (f.length < 6) return null
  return {
    sha: f[0] ?? '',
    short: f[1] ?? '',
    author: f[2] ?? '',
    dateSecs: Number(f[3] ?? 0),
    subject: f[4] ?? '',
    isMerge: (f[5] ?? '').trim().split(/\s+/).filter((s) => s !== '').length > 1,
  }
}

/** Commit list for HEAD, newest first; unborn/broken repo yields an empty list. */
export async function commitList(cwd: string, limit: number): Promise<CommitListResponse> {
  const res = await run(
    ['git', 'log', `-${limit + 1}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P%x1e', 'HEAD'],
    { cwd },
  ).catch(() => null)
  if (!res || res.code !== 0) return { commits: [], truncated: false }
  const records = res.stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r !== '')
  const truncated = records.length > limit
  const commits = records.slice(0, limit).map((rec) => {
    const f = rec.split('\x1f')
    return {
      sha: f[0] ?? '',
      short: f[1] ?? '',
      author: f[2] ?? '',
      dateSecs: Number(f[3] ?? 0),
      subject: f[4] ?? '',
      isMerge: (f[5] ?? '').trim().split(/\s+/).filter((s) => s !== '').length > 1,
    }
  })
  return { commits, truncated }
}

/**
 * Diff of one commit against its first parent (merges show parent-1
 * changes); root commits diff against the empty tree via git show.
 */
export async function commitDiff(cwd: string, sha: string): Promise<DiffResult> {
  if (!isSafeRev(sha)) throw new Error(`unsafe revision: ${sha}`)
  const parent = await run(['git', 'rev-parse', '--verify', `${sha}^`], { cwd })
  if (parent.code === 0) {
    return diffArgs(cwd, ['diff', `${sha}^`, sha, '--no-color', '--unified=3', '--no-ext-diff', '--find-renames'])
  }
  return diffArgs(cwd, ['show', '--format=', sha, '--no-color', '--unified=3', '--no-ext-diff'])
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

/** Undo staging for exact paths (worktree content untouched). */
export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  const res = await run(['git', 'restore', '--staged', '--', ...paths], { cwd })
  if (res.code !== 0) {
    throw new Error(`git restore --staged failed in ${cwd}: ${res.stderr.trim() || `exit ${res.code}`}`)
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

// Remote names: alnum start, no colons (blocks `ext::` helper names), no
// whitespace or option-looking tokens; membership in `git remote` output is
// re-checked at prepare and execute.
export const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

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

/** GitHub owner/repo from HTTPS, scp-style SSH, or ssh:// URLs; null otherwise. */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const u = url.trim().replace(/\.git$/, '')
  if (!u || u.startsWith('-') || u.startsWith('ext::') || u.startsWith('file://')) return null
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(u)
  if (https) return { owner: https[1]!, repo: https[2]! }
  const ssh = /^(?:ssh:\/\/)?(?:git@)?github\.com(?::\d+)?[/:]([^/]+)\/([^/]+)$/.exec(u)
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! }
  return null
}

export type GithubResolveResult =
  | { ok: true; request: GithubRequest }
  | { ok: false; reason: 'unsupported' | 'ambiguous' | 'unavailable'; detail: string }

/**
 * Resolve this checkout's GitHub identity from local config only (no network):
 * head repo = GitHub tracking remote for the branch, else GitHub `origin`,
 * else the sole GitHub remote (multiple = ambiguous). Base repo = GitHub
 * `upstream` remote when present, else null (the provider resolves the fork
 * parent asynchronously). Never trusts option-like remote names/branches.
 */
export async function resolveGithubRequest(
  cwd: string,
  branch: string | null,
  headOid: string | null,
): Promise<GithubResolveResult> {
  if (!branch || branch.startsWith('(') || branch.startsWith('-') || !SAFE_REV.test(branch)) {
    return { ok: false, reason: 'unsupported', detail: 'no usable branch name' }
  }
  if (!headOid || !/^[0-9a-f]{40}$/.test(headOid)) {
    return { ok: false, reason: 'unsupported', detail: 'HEAD is unborn or unresolvable' }
  }
  const namesRes = await run(['git', 'remote'], { cwd }).catch(() => null)
  if (!namesRes || namesRes.code !== 0) {
    return { ok: false, reason: 'unavailable', detail: 'cannot list remotes' }
  }
  const names = namesRes.stdout.split('\n').map((s) => s.trim()).filter((n) => n && !n.startsWith('-'))
  const urls = new Map<string, string>()
  for (const name of names) {
    const res = await run(['git', 'remote', 'get-url', name], { cwd }).catch(() => null)
    if (!res || res.code !== 0) return { ok: false, reason: 'unavailable', detail: 'cannot read remote URL' }
    urls.set(name, res.stdout.trim())
  }
  const githubRemotes = new Map<string, { owner: string; repo: string }>()
  for (const [name, url] of urls) {
    const parsed = parseGithubUrl(url)
    if (parsed) githubRemotes.set(name, parsed)
  }
  if (githubRemotes.size === 0) return { ok: false, reason: 'unsupported', detail: 'no GitHub remote' }

  let head: { owner: string; repo: string } | null = null
  const trackRes = await run(['git', 'config', '--get', `branch.${branch}.remote`], { cwd }).catch(() => null)
  const tracking = trackRes && trackRes.code === 0 ? trackRes.stdout.trim() : ''
  if (tracking && githubRemotes.has(tracking)) head = githubRemotes.get(tracking)!
  else if (githubRemotes.has('origin')) head = githubRemotes.get('origin')!
  else if (githubRemotes.size === 1) head = [...githubRemotes.values()][0]!
  else return { ok: false, reason: 'ambiguous', detail: 'multiple GitHub remotes; set the branch tracking remote' }

  const upstream = githubRemotes.get('upstream') ?? null
  return {
    ok: true,
    request: {
      worktreePath: cwd,
      headRepository: `${head.owner}/${head.repo}`,
      configuredBaseRepository: upstream ? `${upstream.owner}/${upstream.repo}` : null,
      branch,
      headOid,
    },
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

/** Configured remotes: name + fetch url; origin first, then alphabetical. */
export async function remoteNames(cwd: string): Promise<Array<{ name: string; url: string }>> {
  const res = await run(['git', 'remote', '-v'], { cwd }).catch(() => null)
  if (res === null || res.code !== 0) return []
  const byName = new Map<string, string>()
  for (const line of res.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    const name = m?.[1]
    const url = m?.[2]
    if (name !== undefined && url !== undefined && !byName.has(name)) byName.set(name, url)
  }
  const out = [...byName.entries()].map(([name, url]) => ({ name, url }))
  out.sort((a, b) =>
    a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  return out
}

/** Remote component of the upstream ref (longest configured-name match), else null. */
async function upstreamRemote(cwd: string): Promise<string | null> {
  const up = await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd })
  const ref = up.code === 0 ? up.stdout.trim() : ''
  if (!ref || !ref.includes('/')) return null
  const candidates = await remoteNames(cwd)
  let best: string | null = null
  for (const r of candidates) {
    if (ref.startsWith(`${r.name}/`) && (best === null || r.name.length > best.length)) best = r.name
  }
  return best
}

/**
 * Per-remote publish state for `branch` (local refs only — never network).
 * `unpushed` = commits on HEAD missing from <remote>/<branch>; null when
 * the remote-tracking ref is absent (never pushed there) or unresolvable.
 */
export async function remoteStatuses(cwd: string, branch: string, cap: number): Promise<RemoteStatus[]> {
  const remotes = (await remoteNames(cwd)).slice(0, cap)
  if (remotes.length === 0) return []
  const upRemote = await upstreamRemote(cwd)
  const branchOk = SAFE_REV.test(branch)
  const out: RemoteStatus[] = []
  for (const r of remotes) {
    const ref = branchOk && SAFE_REMOTE.test(r.name) ? `refs/remotes/${r.name}/${branch}` : null
    let hasRef = false
    let unpushed: number | null = null
    let behind: number | null = null
    if (ref !== null) {
      const verify = await run(['git', 'show-ref', '--verify', '--quiet', ref], { cwd })
      hasRef = verify.code === 0
      if (hasRef) {
        const counts = await run(['git', 'rev-list', '--left-right', '--count', `${ref}...HEAD`], { cwd })
        if (counts.code === 0) {
          const [behindRaw = '0', aheadRaw = '0'] = counts.stdout.trim().split(/\s+/)
          unpushed = Number(aheadRaw)
          behind = Number(behindRaw)
        }
      }
    }
    out.push({ name: r.name, url: r.url, hasRef, unpushed, behind, upstream: upRemote !== null && upRemote === r.name })
  }
  return out
}

/**
 * Commits on HEAD not present on the remote-tracking branch (newest first,
 * capped at limit). With `remote`, uses `<remote>/<branch>` when that ref
 * exists, else all of HEAD (first push to that remote). Without it, uses
 * upstream when set, else `origin/<branch>` when that ref exists, else all
 * of HEAD (first push).
 */
export async function unpushedCommits(
  cwd: string,
  branch: string,
  limit: number,
  remote?: string,
): Promise<UnpushedResult> {
  let ref: string | null = null
  if (remote !== undefined) {
    if (SAFE_REMOTE.test(remote) && SAFE_REV.test(branch)) {
      const remoteRef = await run(['git', 'show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { cwd })
      if (remoteRef.code === 0) ref = `${remote}/${branch}`
    }
  } else {
    const up = await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd })
    if (up.code === 0 && up.stdout.trim() !== '') {
      ref = up.stdout.trim()
    } else if (SAFE_REV.test(branch)) {
      const remoteRef = await run(['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd })
      if (remoteRef.code === 0) ref = `origin/${branch}`
    }
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
 * Push `branch` to an explicit remote (never bare — kills push.default
 * ambiguity). `-u` only when `setUpstream`. NEVER any force variant — a
 * non-fast-forward is rejected by the remote and surfaced as an error.
 * The remote name must pass SAFE_REMOTE and still be configured here.
 */
export async function pushTo(
  cwd: string,
  remote: string,
  branch: string,
  setUpstream: boolean,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!SAFE_REMOTE.test(remote)) throw new Error(`unsafe remote name: ${remote}`)
  if (!SAFE_REV.test(branch)) throw new Error(`unsafe branch name: ${branch}`)
  const configured = await run(['git', 'remote', 'get-url', remote], { cwd })
  if (configured.code !== 0) throw new Error(`remote not configured: ${remote}`)
  const argv = setUpstream ? ['git', 'push', '-u', remote, branch] : ['git', 'push', remote, branch]
  const res = await run(argv, { cwd, timeoutMs })
  return { code: res.code, stdout: res.stdout, stderr: res.stderr }
}
