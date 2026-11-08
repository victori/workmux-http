import { describe, expect, test } from 'vitest'
import { parseDiff, splitHunkText, buildHunkPatch } from './hunks.js'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,7 +10,9 @@',
  ' context one',
  '-old line',
  '+new line',
  ' context two',
  ' context three',
  ' context four',
  '-second old',
  '+second new',
  '+extra added',
  ' tail',
  'diff --git a/b.png b/b.png',
  'Binary files a/b.png and b/b.png differ',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
].join('\n')

describe('parseDiff', () => {
  const files = parseDiff(DIFF)

  test('should parse modified, binary, and added files', () => {
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'b.png', 'new.txt'])
    expect(files[0]!.status).toBe('modified')
    expect(files[1]!.binary).toBe(true)
    expect(files[2]!.status).toBe('added')
  })

  test('should count additions and deletions', () => {
    const a = files[0]!
    expect(a.additions).toBe(3)
    expect(a.deletions).toBe(2)
  })

  test('should detect splittable hunk at context gap', () => {
    const hunk = files[0]!.hunks[0]!
    expect(hunk.splittable).toBe(true)
    expect(hunk.oldStart).toBe(10)
    expect(hunk.newStart).toBe(10)
    expect(hunk.header).toBe('@@ -10,7 +10,9 @@')
  })

  test('should keep zero-start hunk for new files', () => {
    const hunk = files[2]!.hunks[0]!
    expect(hunk.oldStart).toBe(0)
    expect(hunk.oldCount).toBe(0)
    expect(hunk.splittable).toBe(false)
  })
})

describe('splitHunkText', () => {
  test('should split at context gap and recompute headers', () => {
    const hunk = parseDiff(DIFF)[0]!.hunks[0]!
    const pieces = splitHunkText(hunk.text)
    expect(pieces.length).toBe(2)
    expect(pieces[0]).toContain('-old line')
    expect(pieces[0]).not.toContain('second old')
    expect(pieces[1]).toContain('+extra added')
    for (const piece of pieces) {
      const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(piece)!
      const body = piece.split('\n').slice(1)
      const oldLines = body.filter((l) => l.startsWith(' ') || l.startsWith('-')).length
      const newLines = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length
      expect(Number(m[2])).toBe(oldLines)
      expect(Number(m[4])).toBe(newLines)
    }
  })

  test('should return original for unsplittable hunk', () => {
    const hunk = parseDiff(DIFF)[2]!.hunks[0]!
    expect(splitHunkText(hunk.text)).toEqual([hunk.text])
  })
})

describe('buildHunkPatch', () => {
  test('should produce applicable patch with file headers', () => {
    const patch = buildHunkPatch({ path: 'src/a.ts', oldPath: 'src/a.ts', status: 'modified' }, '@@ -1,1 +1,1 @@\n-a\n+b\n')
    expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(patch).toContain('--- a/src/a.ts')
    expect(patch).toContain('+++ b/src/a.ts')
    expect(patch.endsWith('\n')).toBe(true)
  })
})
