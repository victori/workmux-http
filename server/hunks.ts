import type { FileChangeStatus } from '../shared/types.js'

export interface ParsedHunk {
  header: string
  oldStart: number
  newStart: number
  oldCount: number
  newCount: number
  /** Full hunk text including the @@ header line. */
  text: string
  splittable: boolean
}

export interface ParsedFile {
  path: string
  oldPath: string | null
  status: FileChangeStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: ParsedHunk[]
  /** Full per-file diff text including extended headers. */
  diff: string
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDiff(text: string): ParsedFile[] {
  const files: ParsedFile[] = []
  let current: ParsedFile | null = null
  let fileLines: string[] = []
  let hunk: string[] | null = null

  const flushHunk = () => {
    if (current && hunk && hunk.length > 0) {
      const parsed = parseHunkBody(hunk)
      if (parsed) current.hunks.push(parsed)
    }
    hunk = null
  }
  const flushFile = () => {
    flushHunk()
    if (current) {
      current.diff = fileLines.join('\n')
      files.push(current)
    }
    current = null
    fileLines = []
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushFile()
      fileLines.push(line)
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      current = {
        path: m?.[2] ?? '',
        oldPath: m?.[1] ?? null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        diff: '',
      }
      continue
    }
    if (!current) continue
    fileLines.push(line)
    if (line.startsWith('Binary files ') || line.includes('GIT binary patch')) {
      current.binary = true
      current.status = 'binary'
      continue
    }
    if (line.startsWith('new file mode')) {
      current.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length)
      current.status = 'renamed'
      continue
    }
    if (line.startsWith('--- ')) current.oldPath = line.slice(4).replace(/^a\//, '')
    if (line.startsWith('+++ ')) current.path = line.slice(4).replace(/^b\//, '')
    if (HUNK_RE.test(line)) {
      flushHunk()
      hunk = [line]
      continue
    }
    if (hunk && (/^[-+ ]/.test(line) || line === '' || line.startsWith('\\'))) {
      hunk.push(line)
      if (line.startsWith('+')) current.additions++
      if (line.startsWith('-')) current.deletions++
    }
  }
  flushFile()
  return files.filter((f) => f.binary || f.hunks.length > 0 || f.status !== 'modified')
}

function parseHunkBody(lines: string[]): ParsedHunk | null {
  const header = lines[0] ?? ''
  const m = HUNK_RE.exec(header)
  if (!m) return null
  let contextRun = 0
  let sawSplitGap = false
  let pendingChanges = false
  for (const line of lines.slice(1)) {
    if (line.startsWith('-') || line.startsWith('+')) {
      if (contextRun > 0 && pendingChanges) sawSplitGap = true
      pendingChanges = true
      contextRun = 0
    } else {
      contextRun++
    }
  }
  const body = lines.slice(1)
  return {
    header,
    oldStart: Number(m[1]),
    newStart: Number(m[3]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
    text: lines.join('\n'),
    splittable: sawSplitGap,
  }
}

/** Patch text that applies just this hunk to its file. */
export function buildHunkPatch(file: { path: string; oldPath: string | null; status: FileChangeStatus }, hunkText: string): string {
  const oldPath = file.oldPath ?? file.path
  const header = [`diff --git a/${oldPath} b/${file.path}`]
  if (file.status === 'added') header.push('new file mode 100644')
  if (file.status === 'deleted') header.push('deleted file mode 100644')
  header.push(`--- a/${oldPath}`, `+++ b/${file.path}`)
  return `${[...header, hunkText].join('\n')}\n`
}

/**
 * Split a hunk into pieces at context gaps between change runs, like
 * `git add -p` split. Each piece keeps up to 3 context lines around its changes.
 */
export function splitHunkText(hunkText: string): string[] {
  const lines = hunkText.split('\n')
  const header = lines[0] ?? ''
  const m = HUNK_RE.exec(header)
  if (!m) return [hunkText]
  const body = lines.slice(1).map((l) => (l === '' ? ' ' : l))

  const changeIdx: number[] = []
  body.forEach((line, i) => {
    const isChange = line.startsWith('-') || line.startsWith('+')
    const isMarker = line.startsWith('\\')
    if (isChange || (isMarker && changeIdx[changeIdx.length - 1] === i - 1)) changeIdx.push(i)
  })
  if (changeIdx.length === 0) return [hunkText]

  const groups: number[][] = []
  let group: number[] = [changeIdx[0]!]
  let prev = changeIdx[0]!
  for (const idx of changeIdx.slice(1)) {
    if (idx - prev > 1) {
      groups.push(group)
      group = []
    }
    group.push(idx)
    prev = idx
  }
  groups.push(group)
  if (groups.length <= 1) return [hunkText]

  const oldStart = Number(m[1])
  const newStart = Number(m[3])
  const count = (lines: string[], prefixes: string): number =>
    lines.reduce((n, l) => n + (prefixes.includes(l[0] ?? '') ? 1 : 0), 0)

  return groups.map((g) => {
    const first = g[0]!
    const last = g[g.length - 1]!
    const start = first - Math.min(3, first)
    const end = Math.min(body.length, last + 4)
    const pieceBody = body.slice(start, end)
    const oldCount = count(pieceBody, ' -')
    const newCount = count(pieceBody, ' +')
    const oldPos = oldStart === 0 ? 0 : oldStart + count(body.slice(0, start), ' -')
    const newPos = newStart === 0 ? 0 : newStart + count(body.slice(0, start), ' +')
    return `@@ -${oldPos},${oldCount} +${newPos},${newCount} @@\n${pieceBody.join('\n')}`
  })
}
