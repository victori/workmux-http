import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from './index.js'
import { loadConfig } from './config.js'

/**
 * Route-level security regressions (audit F01/F12): the guard must classify
 * by the router-resolved route, so percent-encoded prefixes cannot skip
 * Host/Origin/header validation; uncaught ZodErrors must be 400.
 */

const app = buildApp(
  loadConfig({ WORKMUX_HTTP_FIXTURES: path.join(process.cwd(), 'fixtures'), WORKMUX_ALLOWED_HOSTS: 'localhost' }),
).app

const MUT = { 'x-workmux-request': '1', 'content-type': 'application/json' }

describe('security hook route classification', () => {
  it('rejects a canonical mutation missing the request header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/%25287/messages',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: { text: 'probe', requestId: 'p1' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('missing_request_header')
  })

  it('rejects a percent-encoded /api prefix mutation (F01)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/%61pi/agents/%25287/messages',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: { text: 'probe', requestId: 'p2' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('missing_request_header')
  })

  it('rejects an encoded-prefix mutation from a forbidden Host (F01)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/%61pi/agents/%25287/messages',
      headers: { host: 'evil.example', ...MUT },
      payload: { text: 'probe', requestId: 'p3' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('forbidden_host')
  })

  it('rejects an encoded-prefix GET from a forbidden Host (F01)', async () => {
    const res = await app.inject({ method: 'GET', url: '/%61pi/health', headers: { host: 'evil.example' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('forbidden_host')
  })

  it('still serves canonical API calls with valid host and header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/%25287/messages',
      headers: { host: 'localhost', ...MUT },
      payload: { text: 'probe', requestId: 'p4' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().delivered).toBe('sent')
  })
})

describe('validation error contract (F12)', () => {
  it('maps an invalid query enum to 400 invalid_request instead of 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/dashboard?force=wrong', headers: { host: 'localhost' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
    expect(String(res.json().detail)).toContain('force')
  })
})
