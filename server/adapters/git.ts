import { readFile } from 'node:fs/promises'
import { run } from '../exec.js'
import { BOUNDS } from '../config.js'
import { parseDiff, type ParsedFile } from '../hunks.js'

export interface RepoStatus {
  branch: string | null
  unborn: boolean
  hasStaged: boolean
  hasUnstaged: boolean
  ahead: number
  behind: number
  untracked: string[]
}

export interface DiffResult {
  files: ParsedFile[]
  truncated: boolean
}

/** Per-repository git facts computed locally; replaces the fragile upstream `status --all --git`. */
export async function repoStatus(cwd: string): Promise<RepoStatus> {
  const res = await run(['git', 'status', '--porcelain=v2', '--branch', '-uall'], { cwd })
  if (res.code !== 0) {
    throw new Error(`git status failed in ${cwd}: ${res.stderr.trim() || `exit ${res.code}`}`)
  }
  const status: RepoStatus = {
    branch: null,
    unborn: false,
    hasStaged: false,
    hasUnstaged: false,
    ahead: 0,
    behind: 0,
    untracked: [],
  }
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      if (line.slice(12).trim() === '(rebase)' || line.includes('unborn')) status.unborn = true
      const oid = line.slice(12).trim()
      if (oid.startsWith('(')) status.unborn = true
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice(13).trim()
      status.branch = head === '(detached)' || head.startsWith('(') ? head : head
    } else if (line.startsWith('# branch.ab ')) {
      const [, ahead, behind] = line.slice(10).split(' ')
      status.ahead = Number(ahead ?? 0)
      status.behind = Math.abs(Number(behind ?? 0))
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const xy = line.slice(1, 3)
      if (xy[0] !== '.') status.hasStaged = true
      if (xy[1] !== '.') status.hasUnstaged = true
      if (line.startsWith('u ')) status.hasStaged = true
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
const SAFE_REV = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

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
