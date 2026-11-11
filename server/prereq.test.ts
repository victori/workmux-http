import { describe, expect, test } from 'vitest'

import type { RunResult } from './exec.js'
import { checkPrerequisites, formatPrereqIssue } from './prereq.js'
import type { PrereqRunner } from './prereq.js'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', truncated: false })
const fail = (stderr = 'not logged in'): RunResult => ({ code: 1, stdout: '', stderr, truncated: false })

function runnerWith(map: Record<string, RunResult>): PrereqRunner {
  return async (argv) => {
    const entry = map[argv.join(' ')]
    if (!entry) throw new Error(`spawn ENOENT: ${argv.join(' ')}`)
    return entry
  }
}

const ALL_PRESENT: Record<string, RunResult> = {
  'tmux -V': ok('tmux 3.5a\n'),
  'workmux --version': ok('workmux 0.7.1\n'),
  'git --version': ok('git version 2.45.0\n'),
  'gh --version': ok('gh version 2.40.1\n'),
  'gh auth status': ok('Logged in to github.com\n'),
}

describe('checkPrerequisites', () => {
  test('should report no issues when every tool is present and authenticated', async () => {
    expect(await checkPrerequisites({ fixtureMode: false, runner: runnerWith(ALL_PRESENT) })).toEqual([])
  })

  test('should warn about every missing required tool', async () => {
    const issues = await checkPrerequisites({ fixtureMode: false, runner: runnerWith({}) })
    const warned = issues.filter((i) => i.level === 'warn').map((i) => i.tool)
    expect(warned).toEqual(['tmux', 'workmux', 'git'])
    expect(issues.some((i) => i.tool === 'gh' && i.level === 'info')).toBe(true)
    expect(issues.find((i) => i.tool === 'tmux')?.message).toContain('required')
  })

  test('should skip all probes in fixture mode', async () => {
    const boobyTrapped: PrereqRunner = async (argv) => {
      throw new Error(`must not run probes in fixture mode: ${argv.join(' ')}`)
    }
    expect(await checkPrerequisites({ fixtureMode: true, runner: boobyTrapped })).toEqual([])
  })

  test('should warn when tmux predates paste-buffer -p', async () => {
    const issues = await checkPrerequisites({
      fixtureMode: false,
      runner: runnerWith({ ...ALL_PRESENT, 'tmux -V': ok('tmux 3.1c\n') }),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.tool).toBe('tmux 3.1')
    expect(issues[0]!.message).toContain('older than 3.2')
  })

  test('should warn when git predates porcelain v2', async () => {
    const issues = await checkPrerequisites({
      fixtureMode: false,
      runner: runnerWith({ ...ALL_PRESENT, 'git --version': ok('git version 2.9.3\n') }),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('older than 2.11')
  })

  test('should warn when gh is installed but unauthenticated', async () => {
    const issues = await checkPrerequisites({
      fixtureMode: false,
      runner: runnerWith({ ...ALL_PRESENT, 'gh auth status': fail() }),
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.tool).toBe('gh')
    expect(issues[0]!.level).toBe('warn')
    expect(issues[0]!.message).toContain('gh auth login')
  })
})

describe('formatPrereqIssue', () => {
  test('prefixes warnings and notes distinctly', () => {
    expect(formatPrereqIssue({ tool: 'tmux', level: 'warn', message: 'gone' })).toBe('WARNING: tmux: gone')
    expect(formatPrereqIssue({ tool: 'gh', level: 'info', message: 'optional' })).toBe('note: gh: optional')
  })
})
