import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RunResult } from '../exec.js'
import { GithubProvider, type GithubRequest } from './github.js'

const calls: Array<{ argv: string[]; cwd?: string }> = []
let queue: RunResult[] = []
let spawnFail = false

vi.mock('../exec.js', () => ({
  run: vi.fn(async (argv: string[], opts: { cwd?: string } = {}) => {
    calls.push({ argv, cwd: opts.cwd })
    if (spawnFail) {
      const err = new Error('spawn gh ENOENT') as Error & { isSpawnFailure: boolean }
      err.isSpawnFailure = true
      throw err
    }
    const next = queue.shift()
    if (!next) throw new Error(`unexpected exec call: ${argv.join(' ')}`)
    return next
  }),
}))

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', truncated: false })
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr, truncated: false })

const HEAD = 'a'.repeat(40)
const target: GithubRequest = {
  worktreePath: '/wt/x',
  headRepository: 'acme/widgets',
  configuredBaseRepository: 'acme/widgets',
  branch: 'feat/demo',
  headOid: HEAD,
}

const ciRollup = (
  contexts: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
) => ok(JSON.stringify({ data: { repository: { object: { __typename: 'Commit', statusCheckRollup: { contexts: { nodes: contexts, pageInfo } } } } } }))

const passingCi = ciRollup([
  { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/widgets/run/1' },
])

function prEntry(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'Demo',
    url: 'https://github.com/acme/widgets/pull/7',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    headRefOid: HEAD,
    headRepository: { name: 'widgets', owner: { login: 'acme' } },
    baseRefName: 'main',
    updatedAt: '2026-11-09T00:00:00Z',
    ...over,
  }
}

/** Fixed identity, empty PR list, exact-HEAD passing CI. */
function githubHarness(ci: RunResult = passingCi, prs: unknown[] = []) {
  queue = [ok(JSON.stringify(prs)), ci]
  const provider = new GithubProvider()
  return { target, read: provider.read.bind(provider), calls }
}

beforeEach(() => {
  calls.length = 0
  queue = []
  spawnFail = false
})

describe('GithubProvider argv contracts', () => {
  test('should use supported gh arguments for PR lookup', async () => {
    const { target: t, read, calls: c } = githubHarness()
    await read(t)
    // The legacy helper used `gh pr view --head …` which the installed CLI rejects.
    expect(c.some(({ argv }) => argv.includes('--head') && argv.includes('view'))).toBe(false)
    expect(c.every(({ argv }) => argv[0] === 'gh')).toBe(true)
    const prCall = c.find(({ argv }) => argv[1] === 'pr')!
    expect(prCall.argv).toEqual([
      'gh',
      'pr',
      'list',
      '--repo',
      'acme/widgets',
      '--head',
      'feat/demo',
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,title,url,state,isDraft,reviewDecision,headRefOid,headRepository,baseRefName,updatedAt',
    ])
    expect(prCall.cwd).toBe('/wt/x')
  })

  test('should scope checks to the exact local commit', async () => {
    const { target: t, read } = githubHarness()
    await read(t)
    const ciCall = calls.find(({ argv }) => argv[1] === 'api')!
    expect(ciCall.argv).toContain(`oid=${HEAD}`)
    expect(ciCall.argv.join(' ')).toContain('statusCheckRollup')
  })

  test('should send a schema-valid CI query (balanced braces, args on contexts)', async () => {
    const { target: t, read } = githubHarness()
    await read(t)
    const ciCall = calls.find(({ argv }) => argv[1] === 'api')!
    const queryArg = ciCall.argv.find((a) => a.startsWith('query='))!
    const query = queryArg.slice('query='.length)
    const opens = (query.match(/{/g) ?? []).length
    const closes = (query.match(/}/g) ?? []).length
    expect(opens).toBe(closes)
    expect(query).toContain('statusCheckRollup {')
    expect(query).toContain('contexts(first:$first, after:$cursor) {')
    expect(query).toContain('nodes {')
    expect(query).toContain('pageInfo { hasNextPage endCursor }')
  })
})

describe('GithubProvider absence vs failure', () => {
  test('should distinguish no PR from provider failure', async () => {
    const ready = githubHarness()
    const noPr = await ready.read(ready.target)
    expect(noPr.state).toBe('ready')
    expect(noPr.pr).toBeNull()
    expect(noPr.error).toBeNull()

    queue = [fail('gh: you are not authenticated (gh auth login)'), passingCi]
    const provider = new GithubProvider()
    const failed = await provider.read(target)
    expect(failed.state).toBe('unavailable')
    expect(failed.error).toContain('not authenticated')
  })

  test('should report unavailable when gh is missing', async () => {
    spawnFail = true
    const provider = new GithubProvider()
    const status = await provider.read(target)
    expect(status.state).toBe('unavailable')
    expect(status.error).toContain('gh CLI not available')
  })

  test('should never conclude no PR from a capped list', async () => {
    const atCap = Array.from({ length: 100 }, (_, i) => prEntry({ number: i + 1 }))
    const { target: t, read } = githubHarness(passingCi, atCap)
    const status = await read(t)
    expect(status.state).toBe('unavailable')
    expect(status.pr).toBeNull()
  })
})

describe('GithubProvider PR matching', () => {
  test('should match the head repository as well as the branch', async () => {
    const foreign = prEntry({
      headRepository: { name: 'widgets', owner: { login: 'evil-corp' } },
    })
    const { target: t, read } = githubHarness(passingCi, [foreign])
    const status = await read(t)
    expect(status.state).toBe('ready')
    expect(status.pr).toBeNull()

    const mine = prEntry()
    const second = githubHarness(passingCi, [mine])
    const matched = await second.read(second.target)
    expect(matched.pr?.number).toBe(7)
    expect(matched.pr?.headRepository).toBe('acme/widgets')
  })

  test('should reject ambiguous multiple open matches', async () => {
    const { target: t, read } = githubHarness(passingCi, [prEntry({ number: 1 }), prEntry({ number: 2 })])
    const status = await read(t)
    expect(status.state).toBe('unavailable')
    expect(status.error).toContain('ambiguous')
  })

  test('should label a historical PR whose head moved', async () => {
    const moved = prEntry({ state: 'MERGED', headRefOid: 'b'.repeat(40) })
    const { target: t, read } = githubHarness(passingCi, [moved])
    const status = await read(t)
    expect(status.state).toBe('ready')
    expect(status.pr?.state).toBe('merged')
    expect(status.pr?.headOid).toBe('b'.repeat(40))
    expect(status.error).toContain('head differs')
  })

  test('should reject non-https PR urls', async () => {
    const weird = prEntry({ url: 'http://github.com/acme/widgets/pull/7' })
    const { target: t, read } = githubHarness(passingCi, [weird])
    const status = await read(t)
    expect(status.state).toBe('unavailable')
  })
})

describe('GithubProvider CI normalization', () => {
  test('should never report incomplete checks as passing', async () => {
    const page = ciRollup(
      [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null }],
      { hasNextPage: true, endCursor: 'c' },
    )
    queue = [ok('[]'), page, page, page, page, page]
    const provider = new GithubProvider()
    const status = await provider.read(target)
    expect(status.ci?.complete).toBe(false)
    expect(status.ci?.state).not.toBe('passing')
    expect(status.ci?.state).toBe('unknown')
  })

  test('should treat unpublished commits as unknown, not empty-passing', async () => {
    const { target: t, read } = githubHarness(ok(JSON.stringify({ data: { repository: { object: null } } })))
    const status = await read(t)
    expect(status.ci?.state).toBe('unknown')
    expect(status.ci?.commitOid).toBe(HEAD)
  })

  test('should treat a null rollup as unknown', async () => {
    const { target: t, read } = githubHarness(ok(JSON.stringify({ data: { repository: { object: { __typename: 'Commit', statusCheckRollup: null } } } })))
    const status = await read(t)
    expect(status.ci?.state).toBe('unknown')
  })

  test('should report none for a successful empty check set', async () => {
    const { target: t, read } = githubHarness(ciRollup([]))
    const status = await read(t)
    expect(status.ci?.state).toBe('none')
    expect(status.ci?.complete).toBe(true)
  })

  test('should rank failing over pending and pending over passing', async () => {
    const mixed = ciRollup([
      { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null },
      { __typename: 'CheckRun', name: 'b', status: 'IN_PROGRESS', conclusion: null, detailsUrl: null },
      { __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: null },
    ])
    const { target: t, read } = githubHarness(mixed)
    const status = await read(t)
    expect(status.ci?.state).toBe('failing')
    expect(status.ci?.counts).toEqual({ passing: 1, failing: 1, pending: 1, neutral: 0, unknown: 0 })
    expect(status.ci?.checks[0]?.name).toBe('c')

    const pend = ciRollup([
      { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null },
      { __typename: 'StatusContext', context: 'ci/jobs', state: 'pending', targetUrl: null },
    ])
    const second = githubHarness(pend)
    const pendingStatus = await second.read(second.target)
    expect(pendingStatus.ci?.state).toBe('pending')
  })

  test('should map unknown conclusions to unknown, blocking passing', async () => {
    const odd = ciRollup([
      { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null },
      { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'FUZZED', detailsUrl: null },
    ])
    const { target: t, read } = githubHarness(odd)
    const status = await read(t)
    expect(status.ci?.state).toBe('unknown')
  })

  test('should treat GraphQL per-field errors as failures despite exit zero', async () => {
    const { target: t, read } = githubHarness(ok(JSON.stringify({ data: { repository: null }, errors: [{ message: 'Bad credentials' }] })))
    const status = await read(t)
    expect(status.ci?.state).toBe('unknown')
    expect(status.error).toContain('GraphQL reported errors')
  })
})

describe('GithubProvider fork base resolution', () => {
  test('should resolve the fork parent when no upstream remote is configured', async () => {
    queue = [
      ok(JSON.stringify({ data: { repository: { parent: { owner: { login: 'upstream-org' }, name: 'widgets' } } } })),
      ok('[]'),
      passingCi,
    ]
    const provider = new GithubProvider()
    const status = await provider.read({ ...target, configuredBaseRepository: null })
    expect(status.state).toBe('ready')
    const prCall = calls.find(({ argv }) => argv[1] === 'pr')!
    expect(prCall.argv).toContain('upstream-org/widgets')
  })

  test('should not guess a base when the parent query fails', async () => {
    queue = [fail('gh: graphql: Could not resolve to a Repository')]
    const provider = new GithubProvider()
    const status = await provider.read({ ...target, configuredBaseRepository: null })
    expect(status.state).toBe('unavailable')
    expect(calls.some(({ argv }) => argv[1] === 'pr')).toBe(false)
  })
})
