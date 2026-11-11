import { z } from 'zod'
import { run, type RunError } from '../exec.js'
import { BOUNDS } from '../config.js'
import type { CiState, CiSummary, GithubStatus, PullRequestInfo } from '../../shared/types.js'

/** Local identity resolved from git config; the adapter resolves the base async. */
export interface GithubRequest {
  worktreePath: string
  headRepository: string
  configuredBaseRepository: string | null
  branch: string
  headOid: string
}

export interface GithubTarget extends GithubRequest {
  baseRepository: string
}

interface GithubReadResult extends GithubStatus {
  ciLookup?: 'retry' | 'bounded'
}

export interface GithubLike {
  read(request: GithubRequest): Promise<GithubReadResult>
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[^\s]+$/
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

const PrListEntrySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean().catch(false),
  reviewDecision: z.string().nullable().optional(),
  headRefOid: z.string(),
  headRepository: z
    .object({
      name: z.string(),
      owner: z.object({ login: z.string() }),
    })
    .nullable()
    .optional(),
  baseRefName: z.string(),
  updatedAt: z.string(),
})

const ForkParentSchema = z.object({
  data: z.object({
    repository: z
      .object({
        parent: z
          .object({
            owner: z.object({ login: z.string() }),
            name: z.string(),
          })
          .nullable(),
      })
      .nullable(),
  }),
})

const CiResponseSchema = z.object({
  data: z.object({
    repository: z
      .object({
        object: z
          .object({
            statusCheckRollup: z
              .object({
                contexts: z
                  .object({
                    nodes: z.unknown(),
                    pageInfo: z
                      .object({
                        hasNextPage: z.boolean().optional(),
                        endCursor: z.string().nullable().optional(),
                      })
                      .optional(),
                  })
                  .nullable()
                  .optional(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .nullable(),
  }),
})

const CheckRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string().catch('check'),
  status: z.string().catch(''),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
})

const StatusContextSchema = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string().catch('status'),
  state: z.string().catch(''),
  targetUrl: z.string().nullable().optional(),
})

/** Per-check outcomes; rollup-only states ('none') never appear here. */
type CheckOutcome = 'passing' | 'failing' | 'pending' | 'neutral' | 'unknown'

interface RawCheck {
  kind: 'check' | 'status'
  name: string
  state: string
  conclusion?: string | null
  url?: string | null
}

/** Cap and scrub provider error text; credential-shaped tokens never escape. */
function scrubError(text: string): string {
  return text
    .replace(/(ghp_|github_pat_|ghs_|ghu_|gho_)[A-Za-z0-9_-]+/g, '$1…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

interface GhResult {
  ok: boolean
  stdout: string
  error: string | null
  missing: boolean
}

async function gh(argv: string[], cwd: string, timeoutMs: number): Promise<GhResult> {
  try {
    const res = await run(['gh', ...argv], { cwd, timeoutMs })
    if (res.code !== 0) {
      return { ok: false, stdout: res.stdout, error: scrubError(res.stderr || `gh exit ${res.code}`), missing: false }
    }
    if (res.truncated) {
      return { ok: false, stdout: res.stdout, error: 'gh output truncated', missing: false }
    }
    return { ok: true, stdout: res.stdout, error: null, missing: false }
  } catch (err) {
    const e = err as RunError
    if (e.isSpawnFailure) return { ok: false, stdout: '', error: 'gh CLI not available', missing: true }
    return { ok: false, stdout: '', error: scrubError(e.message ?? 'gh failed'), missing: false }
  }
}

function unavailable(error: string, attemptedAt = Date.now()): GithubStatus {
  return { state: 'unavailable', pr: null, ci: null, observedAt: null, attemptedAt, error }
}

function unknownCi(commitOid: string): CiSummary {
  return {
    state: 'unknown',
    commitOid,
    complete: false,
    counts: { passing: 0, failing: 0, pending: 0, neutral: 0, unknown: 0 },
    checks: [],
  }
}

const FAILING: Record<string, true> = {
  FAILURE: true,
  TIMED_OUT: true,
  CANCELLED: true,
  ACTION_REQUIRED: true,
  STARTUP_FAILURE: true,
  STALE: true,
  ERROR: true,
}
const PENDING: Record<string, true> = {
  QUEUED: true,
  IN_PROGRESS: true,
  WAITING: true,
  REQUESTED: true,
  PENDING: true,
}

/** Normalize one CheckRun/StatusContext to a CiState via exhaustive tables. */
function normalizeCheck(check: RawCheck): CheckOutcome {
  if (check.kind === 'status') {
    switch (check.state.toUpperCase()) {
      case 'SUCCESS':
        return 'passing'
      case 'PENDING':
        return 'pending'
      case 'FAILURE':
      case 'ERROR':
        return 'failing'
      case 'NEUTRAL':
        return 'neutral'
      default:
        return 'unknown'
    }
  }
  if (PENDING[check.state.toUpperCase()] === true && !check.conclusion) return 'pending'
  const conclusion = (check.conclusion ?? check.state).toUpperCase()
  if (conclusion === 'SUCCESS') return 'passing'
  if (FAILING[conclusion] === true) return 'failing'
  if (PENDING[conclusion] === true) return 'pending'
  if (conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return 'neutral'
  return 'unknown'
}

function safeUrl(url: string | null | undefined): string | null {
  return url && GITHUB_URL_RE.test(url) ? url : null
}

function summarize(checks: RawCheck[], complete: boolean, commitOid: string): CiSummary {
  const counts = { passing: 0, failing: 0, pending: 0, neutral: 0, unknown: 0 }
  const visible: Array<{ name: string; state: CiState; url: string | null }> = []
  for (const c of checks) {
    const s = normalizeCheck(c)
    counts[s] += 1
    visible.push({ name: c.name, state: s, url: safeUrl(c.url) })
  }
  const order: Record<CiState, number> = { failing: 0, pending: 1, unknown: 2, passing: 3, neutral: 4, none: 5 }
  visible.sort((a, b) => order[a.state] - order[b.state])
  // Precedence: failing > pending; unknown or incomplete blocks passing;
  // zero checks or all-neutral means none.
  const state: CiState =
    counts.failing > 0
      ? 'failing'
      : counts.pending > 0
        ? 'pending'
        : counts.unknown > 0 || !complete
          ? 'unknown'
          : counts.passing === 0
            ? 'none'
            : 'passing'
  return { state, commitOid, complete, counts, checks: visible.slice(0, BOUNDS.githubMaxVisibleChecks) }
}

/**
 * GitHub provider over the local `gh` CLI. Structured JSON only — no stderr
 * matching, no human-table parsing. Every failure mode stays distinguishable:
 * unavailable (provider failure/ambiguous/no gh), ready+null PR (complete
 * query, genuinely no PR), unknown CI (unpublished commit, null rollup,
 * partial data). Non-GitHub identities are rejected upstream by
 * resolveGithubRequest. Never queries with client identities.
 */
export class GithubProvider implements GithubLike {
  async read(request: GithubRequest): Promise<GithubReadResult> {
    const started = Date.now()
    const base = await this.resolveBase(request)
    if ('error' in base) return unavailable(base.error, started)
    const target: GithubTarget = { ...request, baseRepository: base.baseRepository }

    const pr = await this.lookupPr(target)
    if ('error' in pr) return unavailable(pr.error, started)

    const ci = await this.lookupCi(target, started)
    const errors = [pr.warning, ci.errorText].filter((e): e is string => e !== null)
    const ciLookup = ci.outcome === 'bounded' ? 'bounded' : ci.errorText !== null && !ci.outcome ? 'retry' : undefined
    return {
      state: 'ready',
      pr: pr.pr,
      ci: ci.summary,
      observedAt: Date.now(),
      attemptedAt: started,
      error: errors.length > 0 ? scrubError(errors.join('; ')) : null,
      ...(ciLookup ? { ciLookup } : {}),
    }
  }

  /** Configured base, else the fork parent via GraphQL; failure is never a guess. */
  private async resolveBase(
    request: GithubRequest,
  ): Promise<{ baseRepository: string } | { error: string }> {
    if (request.configuredBaseRepository) {
      if (!OWNER_REPO_RE.test(request.configuredBaseRepository)) return { error: 'invalid configured base repository' }
      return { baseRepository: request.configuredBaseRepository }
    }
    const [owner, repo] = request.headRepository.split('/')
    if (!owner || !repo || !OWNER_REPO_RE.test(request.headRepository)) {
      return { error: 'invalid head repository' }
    }
    const res = await gh(
      [
        'api',
        'graphql',
        '-f',
        'query=query($owner:String!, $name:String!) { repository(owner:$owner, name:$name) { parent { owner { login } name } } }',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${repo}`,
      ],
      request.worktreePath,
      BOUNDS.githubTimeoutMs,
    )
    if (res.missing) return { error: res.error ?? 'gh CLI not available' }
    if (!res.ok) return { error: res.error ?? 'fork parent lookup failed' }
    const parsed = parseGraphql(res.stdout, ForkParentSchema)
    if ('error' in parsed) return { error: parsed.error }
    const repository = parsed.data.data.repository
    if (repository === null) return { error: 'head repository not found on GitHub' }
    const parent = repository.parent
    return { baseRepository: parent ? `${parent.owner.login}/${parent.name}` : request.headRepository }
  }

  private async lookupPr(
    target: GithubTarget,
  ): Promise<{ pr: PullRequestInfo | null; warning: string | null } | { error: string }> {
    const res = await gh(
      [
        'pr',
        'list',
        '--repo',
        target.baseRepository,
        '--head',
        target.branch,
        '--state',
        'all',
        '--limit',
        String(BOUNDS.githubPrLimit),
        '--json',
        'number,title,url,state,isDraft,reviewDecision,headRefOid,headRepository,baseRefName,updatedAt',
      ],
      target.worktreePath,
      BOUNDS.githubTimeoutMs,
    )
    if (res.missing) return { error: res.error ?? 'gh CLI not available' }
    if (!res.ok) return { error: res.error ?? 'PR lookup failed' }
    let raw: unknown
    try {
      raw = JSON.parse(res.stdout)
    } catch {
      return { error: 'PR lookup returned malformed JSON' }
    }
    if (!Array.isArray(raw)) return { error: 'PR lookup returned unexpected shape' }
    const parsed: z.infer<typeof PrListEntrySchema>[] = []
    for (const entry of raw) {
      const checked = PrListEntrySchema.safeParse(entry)
      if (!checked.success) return { error: 'PR lookup entry malformed' }
      parsed.push(checked.data)
    }
    // At the cap the list is incomplete: never conclude "no PR" from it.
    if (parsed.length >= BOUNDS.githubPrLimit) {
      return { error: 'PR list hit the query cap; ambiguous until pagination' }
    }

    const matching = parsed.filter(
      (p) => p.headRepository && `${p.headRepository.owner.login}/${p.headRepository.name}` === target.headRepository,
    )
    const isOpen = (p: z.infer<typeof PrListEntrySchema>): boolean =>
      p.state.toUpperCase() === 'OPEN' || p.isDraft

    const openExact = matching.filter((p) => isOpen(p) && p.headRefOid === target.headOid)
    if (openExact.length > 1) return { error: 'multiple open PRs match this head; ambiguous' }

    let selected: z.infer<typeof PrListEntrySchema> | null = null
    if (openExact.length === 1) {
      selected = openExact[0]!
    } else {
      const closed = matching
        .filter((p) => !isOpen(p))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const openOther = matching.filter(isOpen)
      if (openOther.length > 1) return { error: 'multiple open PRs match this branch; ambiguous' }
      if (openOther.length === 1) selected = openOther[0]!
      else if (closed.length > 1) return { error: 'multiple closed PRs match this branch; ambiguous' }
      else if (closed.length === 1) selected = closed[0]!
    }
    if (!selected) return { pr: null, warning: null }
    // Historical/moved-head PRs stay displayable but are labeled: their head
    // SHA is not evidence for the current local commit.
    const warning =
      selected.headRefOid !== target.headOid ? `PR head differs from local HEAD (${selected.headRefOid.slice(0, 7)})` : null

    const url = safeUrl(selected.url)
    if (!url) return { error: 'PR url rejected (non-GitHub-https)' }
    const stateRaw =
      selected.isDraft || selected.state.toUpperCase() === 'DRAFT' ? 'draft' : selected.state.toLowerCase()
    if (stateRaw !== 'open' && stateRaw !== 'draft' && stateRaw !== 'merged' && stateRaw !== 'closed') {
      return { error: 'PR state unrecognized' }
    }
    const reviewRaw = (selected.reviewDecision ?? '').toUpperCase()
    const review: PullRequestInfo['review'] =
      reviewRaw === 'APPROVED'
        ? 'approved'
        : reviewRaw === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : reviewRaw === 'REVIEW_REQUIRED'
            ? 'review_required'
            : 'unknown'
    if (!/^[0-9a-f]{40}$/.test(selected.headRefOid)) {
      return { error: 'PR head oid malformed' }
    }
    const headRepo = selected.headRepository
    return {
      pr: {
        number: selected.number,
        title: selected.title,
        url,
        state: stateRaw,
        review,
        headOid: selected.headRefOid,
        headRepository: headRepo ? `${headRepo.owner.login}/${headRepo.name}` : target.headRepository,
        baseRepository: target.baseRepository,
        baseBranch: selected.baseRefName,
      },
      warning,
    }
  }

  /** Exact-HEAD CI with bounded cursor pagination; failure yields unknown, never empty-passing. */
  private async lookupCi(target: GithubTarget, started: number): Promise<{ summary: CiSummary; errorText: string | null; outcome?: 'bounded' | 'unpublished' }> {
    const [owner, repo] = target.baseRepository.split('/')
    if (!owner || !repo) return { summary: unknownCi(target.headOid), errorText: 'invalid base repository' }
    const query =
      'query($owner:String!, $name:String!, $oid:String!, $first:Int!, $cursor:String) {' +
      ' repository(owner:$owner, name:$name) {' +
      '  object(expression:$oid) {' +
      '   __typename' +
      '   ... on Commit {' +
      '    statusCheckRollup {' +
      '     contexts(first:$first, after:$cursor) {' +
      '      nodes {' +
      '       __typename' +
      '       ... on CheckRun { name status conclusion detailsUrl }' +
      '       ... on StatusContext { context state targetUrl }' +
      '      }' +
      '      pageInfo { hasNextPage endCursor }' +
      '     }' +
      '    }' +
      '   }' +
      '  }' +
      ' }' +
      '}'

    const checks: RawCheck[] = []
    let cursor: string | null = null
    for (let page = 0; page < BOUNDS.githubMaxPages; page++) {
      if (Date.now() - started > BOUNDS.githubJobTimeoutMs) {
        return { summary: summarize(checks, false, target.headOid), errorText: 'CI lookup exceeded its deadline' }
      }
      const args = [
        '-f',
        `query=${query}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${repo}`,
        '-F',
        `oid=${target.headOid}`,
        '-F',
        `first=${BOUNDS.githubPageSize}`,
      ]
      if (cursor) args.push('-F', `cursor=${cursor}`)
      const res = await gh(['api', 'graphql', ...args], target.worktreePath, BOUNDS.githubTimeoutMs)
      if (res.missing) return { summary: unknownCi(target.headOid), errorText: res.error ?? 'gh CLI not available' }
      if (!res.ok) return { summary: unknownCi(target.headOid), errorText: res.error ?? 'CI lookup failed' }
      const parsed = parseGraphql(res.stdout, CiResponseSchema)
      if ('error' in parsed) return { summary: unknownCi(target.headOid), errorText: parsed.error }
      const repository = parsed.data.data.repository
      if (repository === null) {
        return { summary: unknownCi(target.headOid), errorText: 'base repository not found' }
      }
      const commit = repository.object
      if (commit === null || commit === undefined) {
        // Commit not visible on the base repo: unpublished — unknown, not empty-passing.
        return { summary: unknownCi(target.headOid), errorText: 'commit not found on GitHub', outcome: 'unpublished' }
      }
      const rollup = commit.statusCheckRollup
      if (!rollup || !rollup.contexts) {
        return { summary: unknownCi(target.headOid), errorText: null }
      }
      if (!Array.isArray(rollup.contexts.nodes)) {
        return { summary: unknownCi(target.headOid), errorText: 'CI contexts malformed' }
      }
      for (const c of rollup.contexts.nodes) {
        const run_ = CheckRunSchema.safeParse(c)
        if (run_.success) {
          checks.push({
            kind: 'check',
            name: run_.data.name,
            state: run_.data.status,
            conclusion: run_.data.conclusion ?? null,
            url: run_.data.detailsUrl ?? null,
          })
          continue
        }
        const status_ = StatusContextSchema.safeParse(c)
        if (status_.success) {
          checks.push({
            kind: 'status',
            name: status_.data.context,
            state: status_.data.state,
            url: status_.data.targetUrl ?? null,
          })
          continue
        }
        checks.push({ kind: 'check', name: 'unknown', state: 'UNKNOWN' })
      }
      if (rollup.contexts.pageInfo?.hasNextPage === true && rollup.contexts.pageInfo.endCursor) {
        cursor = rollup.contexts.pageInfo.endCursor
      } else {
        return { summary: summarize(checks, true, target.headOid), errorText: null }
      }
    }
    return { summary: summarize(checks, false, target.headOid), errorText: 'CI pagination exhausted', outcome: 'bounded' }
  }
}

/** GraphQL envelope: per-field errors are errors even when the CLI exits zero. */
function parseGraphql<T>(stdout: string, schema: z.ZodType<T>): { data: T } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return { error: 'GraphQL returned malformed JSON' }
  }
  if (raw !== null && typeof raw === 'object' && 'errors' in raw) return { error: 'GraphQL reported errors' }
  const checked = schema.safeParse(raw)
  if (!checked.success) return { error: 'GraphQL payload unexpected shape' }
  return { data: checked.data }
}
