import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { Workmux, DependencyError } from './workmux.js'
import type { StatusPayload } from './workmux.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures')

function fakeWorkmux(body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wmfake-'))
  const file = path.join(dir, 'workmux')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

const VALID_LIST = `cat ${FIXTURES}/list-all.json`
const VALID_STATUS = `cat ${FIXTURES}/status-all.json`

describe('Workmux adapter', () => {
  test('should parse valid list payload', async () => {
    const wm = new Workmux(fakeWorkmux(VALID_LIST))
    const list = await wm.listAll()
    expect(list.length).toBeGreaterThan(0)
    expect(list[0]).toMatchObject({
      project: expect.any(String),
      project_path: expect.any(String),
      handle: expect.any(String),
      is_main: expect.any(Boolean),
      agent_statuses: expect.any(Array),
    })
  })

  test('should parse valid status payload with pane identity', async () => {
    const wm = new Workmux(fakeWorkmux(VALID_STATUS))
    const status: StatusPayload = await wm.statusAll()
    expect(status.context.backend).toBe('tmux')
    const agent = status.agents[0]!
    expect(agent.pane_id).toMatch(/^%/)
    expect(agent).toHaveProperty('session')
    expect(agent).toHaveProperty('updated_ts')
  })

  test('should throw DependencyError on failed command', async () => {
    const wm = new Workmux(fakeWorkmux('echo "boom" >&2; exit 2'))
    await expect(wm.listAll()).rejects.toThrow(DependencyError)
    await expect(wm.statusAll()).rejects.toThrow(/exit 2/)
  })

  test('should throw DependencyError on malformed JSON', async () => {
    const wm = new Workmux(fakeWorkmux('echo "not json {"'))
    await expect(wm.listAll()).rejects.toThrow(/malformed JSON/)
  })

  test('should reject unexpected payload shape', async () => {
    const wm = new Workmux(fakeWorkmux('echo \'[{"nope":1}]\''))
    await expect(wm.listAll()).rejects.toThrow(/unexpected payload shape/)
  })

  test('should accept empty observations as valid empties', async () => {
    const wm = new Workmux(fakeWorkmux('echo "[]"'))
    expect(await wm.listAll()).toEqual([])
  })

  test('should accept null project fields and derive project from workdir', async () => {
    const wm = new Workmux(
      fakeWorkmux(
        `echo '{"context":{"backend":"tmux","instance":"default"},"scope":null,"agents":[{"worktree":"wt","branch":"b","project":null,"project_path":null,"status":"waiting","elapsed_secs":1,"title":null,"pane_id":"%7","workdir":"/repos/myapp","agent_kind":null,"session":"s","window_name":null,"updated_ts":1}]}'`,
      ),
    )
    const status = await wm.statusAll()
    expect(status.agents[0]!.project).toBeNull()
  })

  test('should report missing binary as DependencyError', async () => {
    const wm = new Workmux('/nonexistent/workmux-binary')
    await expect(wm.listAll()).rejects.toThrow(DependencyError)
    expect(await wm.version()).toBeNull()
  })
})
