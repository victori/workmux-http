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

/** Decode a Git C-style quoted path token (`"caf\303\251.txt"`) into real UTF-8 text. */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const inner = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!
    if (c !== '\\') {
      bytes.push(c.charCodeAt(0))
      continue
    }
    const e = inner[++i]
    if (e === undefined) {
      bytes.push(92)
      break
    }
    switch (e) {
      case 'n': bytes.push(10); break
      case 't': bytes.push(9); break
      case 'b': bytes.push(8); break
      case 'a': bytes.push(7); break
      case 'f': bytes.push(12); break
      case 'v': bytes.push(11); break
      case '\\': bytes.push(92); break
      case '"': bytes.push(34); break
      default: {
        if (e >= '0' && e <= '7') {
          let val = e.charCodeAt(0) - 48
          for (let d = 1; d < 3 && inner[i + 1]! >= '0' && inner[i + 1]! <= '7'; d++) {
            val = val * 8 + (inner[++i]!.charCodeAt(0) - 48)
          }
          bytes.push(val)
        } else {
          bytes.push(92, e.charCodeAt(0))
        }
      }
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

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

  const arr = text.split('\n')
  for (let i = 0; i < arr.length; i++) {
    const line = arr[i]!
    if (line.startsWith('diff --git ')) {
      flushFile()
      fileLines.push(line)
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      current = {
        path: m ? unquoteGitPath(m[2]!) : '',
        oldPath: m ? unquoteGitPath(m[1]!) : null,
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
    // `--- `/`+++ ` are file headers only while no hunk is open; inside a
    // hunk they are content lines (pushed and counted below).
    if (!hunk) {
      if (line.startsWith('--- ') && line.slice(4) !== '/dev/null') {
        current.oldPath = unquoteGitPath(line.slice(4).replace(/^a\//, ''))
      }
      if (line.startsWith('+++ ') && line.slice(4) !== '/dev/null') {
        current.path = unquoteGitPath(line.slice(4).replace(/^b\//, ''))
      }
    }
    if (HUNK_RE.test(line)) {
      flushHunk()
      hunk = [line]
      continue
    }
    if (hunk && (/^[-+ ]/.test(line) || line === '' || line.startsWith('\\'))) {
      // A trailing '' after the file's final newline is a split artifact,
      // not a blank context line; pushing it would fake an extra context row.
      if (line === '' && i === arr.length - 1) continue
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
 * `git add -p` split. Each piece keeps only unchanged context around its
 * changes (up to 3 lines per side) so pieces never absorb a neighbor's
 * +/- lines and each applies cleanly.
 */
export function splitHunkText(hunkText: string): string[] {
  const lines = hunkText.split('\n')
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
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
  const count = (ls: string[], pred: (l: string) => boolean): number =>
    ls.reduce((n, l) => n + (pred(l) ? 1 : 0), 0)

  return groups.map((g) => {
    const first = g[0]!
    const last = g[g.length - 1]!
    // Context = consecutive unchanged lines directly adjacent to the group,
    // capped at 3; a change or marker line bounds the run, so pieces never
    // cross into a neighboring group's changes. A blank line is an empty
    // context line and counts toward both sides.
    const isCtx = (l: string): boolean => l === '' || l.startsWith(' ')
    let start = first
    for (let ctx = 0; ctx < 3 && start > 0 && isCtx(body[start - 1]!); ctx++) start--
    let end = last + 1
    for (let ctx = 0; ctx < 3 && end < body.length && isCtx(body[end]!); ctx++) end++
    // A "\ No newline at end of file" marker directly after the piece's last
    // line belongs to the piece but counts toward neither side.
    if (end < body.length && body[end]!.startsWith('\\')) end++
    const pieceBody = body.slice(start, end)
    const oldCount = count(pieceBody, (l) => isCtx(l) || l.startsWith('-'))
    const newCount = count(pieceBody, (l) => isCtx(l) || l.startsWith('+'))
    const oldPos = oldStart === 0 ? 0 : oldStart + count(body.slice(0, start), (l) => isCtx(l) || l.startsWith('-'))
    const newPos = newStart === 0 ? 0 : newStart + count(body.slice(0, start), (l) => isCtx(l) || l.startsWith('+'))
    return `@@ -${oldPos},${oldCount} +${newPos},${newCount} @@\n${pieceBody.join('\n')}`
  })
}
