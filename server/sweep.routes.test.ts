import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from './index.js'
import { loadConfig } from './config.js'

/**
 * Route-level contract for the clean-sweep endpoints: strict validation,
 * security gates, fixture-mode refusal, and the 404/409 error mapping.
 * Real removal is never exercised here (service + integration suites own
 * that surface).
 */

const MUT = { 'x-workmux-request': '1', 'content-type': 'application/json' }

const fixtureApp = buildApp(
  loadConfig({ WORKMUX_HTTP_FIXTURES: path.join(process.cwd(), 'fixtures'), WORKMUX_ALLOWED_HOSTS: 'localhost' }),
).app

const liveApp = buildApp(
  loadConfig({ WORKMUX_ALLOWED_HOSTS: 'localhost', WORKMUX_TMUX_SOCKET: 'wmhttp-routes-absent' }),
).app

describe('sweep route validation', () => {
  it('rejects an empty scan selection', async () => {
    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/sweeps/scan',
      headers: { host: 'localhost', ...MUT },
      payload: { worktreeIds: [], requestId: 'r1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('rejects unknown fields such as force on scan', async () => {
    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/sweeps/scan',
      headers: { host: 'localhost', ...MUT },
      payload: { worktreeIds: ['wt_a'], requestId: 'r1', force: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('rejects malformed confirm tokens on execute', async () => {
    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/sweeps/execute',
      headers: { host: 'localhost', ...MUT },
      payload: { confirmToken: 'DEADBEEF!', acceptWarnings: true, requestId: 'r1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
  })

  it('refuses every sweep endpoint in fixture mode', async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['/api/sweeps/scan', { worktreeIds: ['wt_b456a632633f'], requestId: 'r1' }],
      ['/api/sweeps/prepare', { scanId: 'scan-1', worktreeIds: ['wt_b456a632633f'], keepBranches: true, requestId: 'r2' }],
      ['/api/sweeps/execute', { confirmToken: 'a'.repeat(24), acceptWarnings: true, requestId: 'r3' }],
    ]
    for (const [url, payload] of bodies) {
      const res = await fixtureApp.inject({ method: 'POST', url, headers: { host: 'localhost', ...MUT }, payload })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('bad_request')
      expect(res.json().detail).toContain('fixture mode')
    }
  })
})

describe('sweep route security', () => {
  it('rejects sweep mutations without the request header', async () => {
    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/sweeps/scan',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: { worktreeIds: ['wt_a'], requestId: 'r1' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('missing_request_header')
  })

  it('rejects sweep mutations from a forbidden host', async () => {
    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/sweeps/scan',
      headers: { host: 'evil.example', ...MUT },
      payload: { worktreeIds: ['wt_a'], requestId: 'r1' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('forbidden_host')
  })

  it('rejects a cross-origin sweep execute', async () => {
    const res = await fixtureApp.inject({
      method: 'POST',
      url: '/api/sweeps/execute',
      headers: { host: 'localhost', origin: 'https://evil.example', ...MUT },
      payload: { confirmToken: 'a'.repeat(24), acceptWarnings: true, requestId: 'r1' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('cross_origin')
  })
})

describe('sweep route error mapping (non-fixture)', () => {
  it('maps unmanaged scan targets to 404', async () => {
    const res = await liveApp.inject({
      method: 'POST',
      url: '/api/sweeps/scan',
      headers: { host: 'localhost', ...MUT },
      payload: { worktreeIds: ['wt_ghost00000000'], requestId: 'r1' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('target_not_found')
  })

  it('maps an unknown scan id to 409 snapshot_stale', async () => {
    const res = await liveApp.inject({
      method: 'POST',
      url: '/api/sweeps/prepare',
      headers: { host: 'localhost', ...MUT },
      payload: { scanId: 'nope-not-a-scan', worktreeIds: ['wt_a'], keepBranches: true, requestId: 'r2' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('snapshot_stale')
  })

  it('maps an unknown confirm token to 409 confirmation_required', async () => {
    const res = await liveApp.inject({
      method: 'POST',
      url: '/api/sweeps/execute',
      headers: { host: 'localhost', ...MUT },
      payload: { confirmToken: 'f'.repeat(24), acceptWarnings: true, requestId: 'r3' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('confirmation_required')
  })
})
