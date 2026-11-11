import { describe, expect, test } from 'vitest'
import { parseDiff, splitHunkText, buildHunkPatch } from './hunks.js'

function headerCounts(piece: string): { oldPos: number; oldCount: number; newPos: number; newCount: number } {
  const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(piece)!
  return { oldPos: Number(m[1]), oldCount: Number(m[2]), newPos: Number(m[3]), newCount: Number(m[4]) }
}

function bodyCounts(piece: string): { oldCount: number; newCount: number } {
  const body = piece.split('\n').slice(1)
  const ctx = (l: string): boolean => l === '' || l.startsWith(' ')
  return {
    oldCount: body.filter((l) => ctx(l) || l.startsWith('-')).length,
    newCount: body.filter((l) => ctx(l) || l.startsWith('+')).length,
  }
}

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

describe('parseDiff header-lookalikes inside hunks', () => {
  const sneaky = [
    'diff --git a/src/real.ts b/src/real.ts',
    'index 1111111..2222222 100644',
    '--- a/src/real.ts',
    '+++ b/src/real.ts',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '++ unexpected-path',
    '--- fake',
    ' end',
  ].join('\n')
  const files = parseDiff(sneaky)

  test('should keep real file path when hunk content starts with ++ or ---', () => {
    expect(files[0]!.path).toBe('src/real.ts')
    expect(files[0]!.oldPath).toBe('src/real.ts')
    expect(files[0]!.additions).toBe(1)
    expect(files[0]!.deletions).toBe(1)
  })

  test('should emit only real paths in hunk patch headers', () => {
    const patch = buildHunkPatch(files[0]!, files[0]!.hunks[0]!.text)
    expect(patch.split('\n').slice(0, 4)).toEqual([
      'diff --git a/src/real.ts b/src/real.ts',
      '--- a/src/real.ts',
      '+++ b/src/real.ts',
      '@@ -1,3 +1,4 @@',
    ])
  })
})

describe('parseDiff /dev/null and quoted paths', () => {
  const deleted = [
    'diff --git a/f.txt b/f.txt',
    'deleted file mode 100644',
    'index 9daeafb..0000000',
    '--- a/f.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-gone',
  ].join('\n')

  test('should keep real path for deleted file with /dev/null header', () => {
    const f = parseDiff(deleted)[0]!
    expect(f.path).toBe('f.txt')
    expect(f.oldPath).toBe('f.txt')
    expect(f.status).toBe('deleted')
    const patch = buildHunkPatch(f, f.hunks[0]!.text)
    expect(patch).toContain('--- a/f.txt')
    expect(patch).toContain('+++ b/f.txt')
    expect(patch).not.toContain('/dev/null')
  })

  test('should keep added-file path free of /dev/null sentinel', () => {
    const f = parseDiff(DIFF)[2]!
    expect(f.path).toBe('new.txt')
    expect(f.oldPath).toBe('new.txt')
    const patch = buildHunkPatch(f, f.hunks[0]!.text)
    expect(patch).toContain('+++ b/new.txt')
    expect(patch).not.toContain('/dev/null')
  })

  test('should decode C-style quoted unicode paths', () => {
    const quoted = [
      'diff --git a/"caf\\303\\251.txt" b/"caf\\303\\251.txt"',
      'index 1111111..2222222 100644',
      '--- a/"caf\\303\\251.txt"',
      '+++ b/"caf\\303\\251.txt"',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n')
    const f = parseDiff(quoted)[0]!
    expect(f.path).toBe('café.txt')
    expect(f.oldPath).toBe('café.txt')
    const patch = buildHunkPatch(f, f.hunks[0]!.text)
    expect(patch).toContain('diff --git a/café.txt b/café.txt')
    expect(patch).toContain('+++ b/café.txt')
    expect(patch).not.toContain('\\303')
  })
})

describe('splitHunkText piece isolation', () => {
  // 7-line file, lines 2 and 4 changed: only one context line between edits.
  const near = [
    '@@ -1,7 +1,7 @@',
    ' l1',
    '-l2',
    '+L2',
    ' l3',
    '-l4',
    '+L4',
    ' l5',
    ' l6',
    ' l7',
  ].join('\n')
  const pieces = splitHunkText(near)

  test('should isolate each edit in its own piece', () => {
    expect(pieces.length).toBe(2)
    expect(pieces[0]).toContain('-l2')
    expect(pieces[0]).toContain('+L2')
    expect(pieces[0]).not.toContain('-l4')
    expect(pieces[0]).not.toContain('+L4')
    expect(pieces[1]).toContain('-l4')
    expect(pieces[1]).toContain('+L4')
    expect(pieces[1]).not.toContain('-l2')
    expect(pieces[1]).not.toContain('+L2')
  })

  test('should declare counts matching piece bodies', () => {
    for (const piece of pieces) {
      const h = headerCounts(piece)
      const b = bodyCounts(piece)
      expect(h.oldCount).toBe(b.oldCount)
      expect(h.newCount).toBe(b.newCount)
    }
  })

  test('should anchor first piece at hunk start positions', () => {
    expect(headerCounts(pieces[0]!).oldPos).toBe(1)
    expect(headerCounts(pieces[0]!).newPos).toBe(1)
  })

  test('should keep adjacent edits in one piece', () => {
    const adjacent = ['@@ -1,5 +1,6 @@', ' c1', '-x', '+y', '+z', ' c2', ' c3'].join('\n')
    expect(splitHunkText(adjacent)).toEqual([adjacent])
  })

  test('should count insert-only and delete-only groups correctly', () => {
    const mixed = [
      '@@ -5,6 +5,7 @@',
      ' c1',
      '-d2',
      ' c3',
      ' c4',
      '+ins',
      ' c5',
      ' c6',
    ].join('\n')
    const ps = splitHunkText(mixed)
    expect(ps.length).toBe(2)
    expect(headerCounts(ps[0]!)).toEqual({ oldPos: 5, oldCount: 4, newPos: 5, newCount: 3 })
    expect(headerCounts(ps[1]!)).toEqual({ oldPos: 7, oldCount: 4, newPos: 6, newCount: 5 })
    for (const p of ps) {
      const h = headerCounts(p)
      const b = bodyCounts(p)
      expect(h.oldCount).toBe(b.oldCount)
      expect(h.newCount).toBe(b.newCount)
    }
  })

  test('should attach no-newline marker to its piece without counting it', () => {
    const markered = [
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      '-e',
      '+E',
      '\\ No newline at end of file',
    ].join('\n')
    const ps = splitHunkText(markered)
    expect(ps.length).toBe(2)
    expect(ps[0]!.includes('\\ No newline')).toBe(false)
    expect(ps[1]!.endsWith('\\ No newline at end of file')).toBe(true)
    for (const p of ps) {
      const h = headerCounts(p)
      const b = bodyCounts(p)
      expect(h.oldCount).toBe(b.oldCount)
      expect(h.newCount).toBe(b.newCount)
    }
  })

  test('should count blank context lines toward both sides', () => {
    const blanked = [
      '@@ -1,6 +1,7 @@',
      ' line one',
      '',
      '+inserted after blank',
      ' line three',
      '',
      '-line five',
      '+five new',
      ' line seven',
    ].join('\n')
    const ps = splitHunkText(blanked)
    expect(ps.length).toBe(2)
    expect(ps[0]).not.toMatch(/line five|five new/)
    expect(ps[1]).not.toContain('inserted after blank')
    for (const p of ps) {
      const h = headerCounts(p)
      const b = bodyCounts(p)
      expect(h.oldCount).toBe(b.oldCount)
      expect(h.newCount).toBe(b.newCount)
    }
    expect(headerCounts(ps[0]!)).toEqual({ oldPos: 1, oldCount: 4, newPos: 1, newCount: 5 })
    expect(headerCounts(ps[1]!)).toEqual({ oldPos: 3, oldCount: 4, newPos: 4, newCount: 4 })
  })

  test('should not treat the terminal newline as a blank context line', () => {
    const raw = [
      'diff --git a/f.txt b/f.txt',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '',
    ].join('\n')
    const h = parseDiff(raw)[0]!.hunks[0]!
    expect(h.text.endsWith('\n')).toBe(false)
    const ps = splitHunkText(h.text)
    expect(ps.length).toBe(1)
    expect(headerCounts(ps[0]!)).toEqual({ oldPos: 1, oldCount: 3, newPos: 1, newCount: 3 })
    const b = bodyCounts(ps[0]!)
    expect(b).toEqual({ oldCount: 3, newCount: 3 })
  })
})
