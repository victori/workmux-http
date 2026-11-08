import { createHash } from 'node:crypto'

/** Opaque, server-issued worktree id scoped to project + path. */
export function worktreeId(project: string, path: string): string {
  return `wt_${createHash('sha1').update(`${project}\u0000${path}`).digest('hex').slice(0, 12)}`
}

export function snapshotId(diffText: string): string {
  return createHash('sha256').update(diffText).digest('hex').slice(0, 16)
}

export function confirmTokenOf(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

export function isValidWorktreeName(name: string): boolean {
  return NAME_RE.test(name) && !name.startsWith('-') && !name.endsWith('.lock')
}
