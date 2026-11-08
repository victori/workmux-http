import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Spec drift harness: machine-checks the enumerable tables in docs/SPEC.md
 * against their code sources. Adding/removing a route, env var, or error
 * code without updating the spec fails the suite — docs stay honest without
 * relying on discipline.
 */

const root = process.cwd()
const spec = readFileSync(path.join(root, 'docs/SPEC.md'), 'utf8')
const indexSrc = readFileSync(path.join(root, 'server/index.ts'), 'utf8')
const securitySrc = readFileSync(path.join(root, 'server/security.ts'), 'utf8')
const configSrc = readFileSync(path.join(root, 'server/config.ts'), 'utf8')

/** Slice of the spec between a `check:<name>` marker and the next marker/heading. */
function specSection(name: string): string {
  const start = spec.indexOf(`<!-- check:${name} -->`)
  expect(start, `SPEC.md missing marker <!-- check:${name} -->`).toBeGreaterThanOrEqual(0)
  const rest = spec.slice(start + `<!-- check:${name} -->`.length)
  const end = rest.search(/\n<!-- check:|\n## /)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('SPEC.md routes match the server', () => {
  const sourceRoutes: string[] = []
  for (const line of indexSrc.split('\n')) {
    const m = line.match(/\b(?:app|scope)\.(get|post|delete|put|patch)\('([^']+)'/)
    if (!m) continue
    const method = line.includes('websocket: true') ? 'WS' : (m[1] ?? 'get').toUpperCase()
    sourceRoutes.push(`${method} ${m[2] ?? ''}`)
  }

  const specRoutes = [...specSection('routes').matchAll(/^\| `(GET|POST|WS) (\/[^`\s]*)` \|/gm)]
    .flatMap(([, method, route]) => (method && route ? [`${method} ${route}`] : []))

  test('should list every registered route', () => {
    expect([...sourceRoutes].sort()).toEqual(specRoutes.slice().sort())
  })

  test('should not document routes that no longer exist', () => {
    expect(specRoutes.filter((r) => !sourceRoutes.includes(r))).toEqual([])
  })
})

describe('SPEC.md error codes match the server', () => {
  const codes = new Set<string>()
  for (const src of [indexSrc, securitySrc]) {
    for (const m of src.matchAll(/error: '([a-z_]+)'/g)) if (m[1]) codes.add(m[1])
  }

  const specCodes = [...specSection('errors').matchAll(/^\| `([a-z_]+)` \|/gm)].flatMap(([, c]) => (c ? [c] : []))

  test('should document every emitted error code', () => {
    expect([...codes].sort()).toEqual(specCodes.slice().sort())
  })

  test('should not document codes the server never emits', () => {
    expect(specCodes.filter((c) => !codes.has(c))).toEqual([])
  })
})

describe('SPEC.md env vars match config', () => {
  // Dynamic per-kind commands are documented as WORKMUX_<KIND>_…_CMD.
  const dynamicCovered = (name: string): boolean =>
    /^WORKMUX_[A-Z0-9]+_(COMMIT|PUSH)_CMD$/.test(name)

  const literals = [...configSrc.matchAll(/WORKMUX_[A-Z0-9_]+/g)].map((m) => m[0])
  const required = [...new Set(literals)].filter((v) => !dynamicCovered(v))

  const specVars = [
    ...new Set(
      [...specSection('env').matchAll(/WORKMUX_(?:[A-Z0-9_]+|<KIND>_(?:COMMIT|PUSH)_CMD)/g)].map(
        (m) => m[0],
      ),
    ),
  ]

  test('should document every config env var', () => {
    const missing = required.filter((v) => !specVars.includes(v))
    expect(missing, `undocumented env vars: ${missing.join(', ')}`).toEqual([])
  })

  test('should document the dynamic commit/push command pattern', () => {
    expect(specVars).toContain('WORKMUX_<KIND>_COMMIT_CMD')
    expect(specVars).toContain('WORKMUX_<KIND>_PUSH_CMD')
    expect(configSrc).toContain('WORKMUX_${alias}_COMMIT_CMD')
    expect(configSrc).toContain('WORKMUX_${alias}_PUSH_CMD')
  })

  test('should not document env vars config never reads', () => {
    const unknown = specVars.filter(
      (v) => !v.includes('<KIND>') && !literals.includes(v),
    )
    expect(unknown, `spec lists unknown env vars: ${unknown.join(', ')}`).toEqual([])
  })
})

describe('SPEC.md structural rules', () => {
  test('should carry all required sections', () => {
    for (const heading of [
      'System model',
      'Security model',
      'HTTP API',
      'Core invariants',
      'State machines',
      'WebSocket protocol',
      'Configuration',
      'Verification gate',
      'Doc map',
    ]) {
      expect(spec, `SPEC.md missing section: ${heading}`).toContain(heading)
    }
  })

  test('should state a precedence rule', () => {
    expect(spec).toMatch(/Precedence on conflict/)
  })

  test('should not hardcode volatile test counts', () => {
    expect(spec).not.toMatch(/\b\d{2,3}\s+(vitest|e2e|tests)\b/i)
  })

  test('should be referenced from AGENTS.md spec maintenance rules', () => {
    const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('docs/SPEC.md')
  })
})
