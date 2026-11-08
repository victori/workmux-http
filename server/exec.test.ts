import { describe, expect, test, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './exec.js'

describe('exec.run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wmexec-'))

  test('should deliver stdin EOF so stdin-reading commands do not hang', async () => {
    const started = Date.now()
    const r = await run(['/bin/sh', '-c', 'cat > out.txt; echo EOF'], {
      cwd: dir,
      timeoutMs: 5000,
    })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('EOF')
    expect(Date.now() - started).toBeLessThan(4000)
  })

  test('should pass explicit input then EOF', async () => {
    const r = await run(['/bin/sh', '-c', 'cat'], { cwd: dir, timeoutMs: 5000, input: 'payload' })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('payload')
  })

  test('should kill the whole process group on timeout', async () => {
    const marker = join(dir, 'late-marker')
    const started = Date.now()
    const r = await run(
      ['/bin/sh', '-c', `sleep 10; echo late > ${JSON.stringify(marker)}`],
      { cwd: dir, timeoutMs: 800 },
    )
    expect(r.code).toBe(124)
    expect(Date.now() - started).toBeLessThan(3000)
    await new Promise((res) => setTimeout(res, 1200))
    expect(() => run(['/bin/sh', '-c', `test -e ${JSON.stringify(marker)}`])).not.toThrow()
    const check = await run(['/bin/sh', '-c', `test -e ${JSON.stringify(marker)} && echo Y || echo N`])
    expect(check.stdout.trim()).toBe('N')
  })

  test('should reject spawn failures', async () => {
    await expect(run(['/nonexistent-binary-xyz'])).rejects.toThrow()
  })

  test('should truncate oversized output and flag it', async () => {
    const r = await run(['/bin/sh', '-c', 'yes x | head -c 100000'])
    expect(r.code).toBe(0)
    expect(r.stdout.length).toBeLessThanOrEqual(1_000_000)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})
