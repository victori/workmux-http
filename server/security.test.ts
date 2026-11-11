import { describe, expect, test } from 'vitest'
import { checkRequest, hostAllowed, originMatches, type RequestLike } from './security.js'
import { loadConfig, type AppConfig } from './config.js'

const cfg: AppConfig = {
  ...loadConfig({ WORKMUX_HTTP_PORT: '3000' }),
  bind: '127.0.0.1',
  allowedHosts: ['vpn.example.ts.net'],
}

function req(method: string, headers: RequestLike['headers']): RequestLike {
  return { method, headers }
}

describe('host allowlist', () => {
  test('should accept loopback and configured bind', () => {
    expect(hostAllowed('127.0.0.1:3000', cfg)).toBe(true)
    expect(hostAllowed('localhost:3000', cfg)).toBe(true)
  })

  test('should accept configured VPN host only', () => {
    expect(hostAllowed('vpn.example.ts.net', cfg)).toBe(true)
    expect(hostAllowed('evil.example.com', cfg)).toBe(false)
  })

  test('should reject missing host header', () => {
    expect(hostAllowed(undefined, cfg)).toBe(false)
  })

  test('should reject inherited Object property names as hostnames', () => {
    expect(hostAllowed('constructor:3000', cfg)).toBe(false)
    expect(hostAllowed('__proto__:3000', cfg)).toBe(false)
    expect(hostAllowed('toString:3000', cfg)).toBe(false)
  })

  test('should reject non-mutation method names that are prototype keys', () => {
    // A `constructor` "method" must not be treated as a mutation either.
    expect(checkRequest(req('constructor', { host: 'localhost:3000' }), cfg).ok).toBe(true)
  })

  test('should accept any host with WORKMUX_ALLOWED_HOSTS=*', () => {
    const open: AppConfig = { ...cfg, allowAnyHost: true }
    expect(hostAllowed('evil.example.com', open)).toBe(true)
    expect(hostAllowed('198.51.100.7:3000', open)).toBe(true)
    expect(hostAllowed(undefined, open)).toBe(false) // missing Host still rejected
  })

  test('should parse * into allowAnyHost and strip it from the list', () => {
    const open = loadConfig({ WORKMUX_ALLOWED_HOSTS: '*,vpn.example.ts.net' })
    expect(open.allowAnyHost).toBe(true)
    expect(open.allowedHosts).toEqual(['vpn.example.ts.net'])
    expect(loadConfig({}).allowAnyHost).toBe(false)
  })
})

describe('origin checks', () => {
  test('should allow absent Origin (non-browser clients)', () => {
    expect(originMatches(req('POST', { host: 'localhost:3000' }), cfg)).toBe(true)
  })

  test('should allow same-origin', () => {
    expect(originMatches(req('POST', { host: 'localhost:3000', origin: 'http://localhost:3000' }), cfg)).toBe(true)
  })

  test('should reject cross-origin', () => {
    expect(originMatches(req('POST', { host: 'localhost:3000', origin: 'http://evil.test' }), cfg)).toBe(false)
  })

  test('should reject same host different port', () => {
    expect(
      originMatches(req('POST', { host: 'localhost:3000', origin: 'http://localhost:8080' }), cfg),
    ).toBe(false)
  })

  test('should reject https Origin against the plain-HTTP server', () => {
    expect(
      originMatches(req('POST', { host: 'localhost:3000', origin: 'https://localhost:3000' }), cfg),
    ).toBe(false)
    const verdict = checkRequest(
      req('POST', { host: 'localhost:3000', origin: 'https://localhost:3000', 'x-workmux-request': '1' }),
      cfg,
    )
    expect(verdict).toMatchObject({ ok: false, status: 403, error: 'cross_origin' })
  })

  test('should reject WS upgrade from foreign local origin', () => {
    const verdict = checkRequest(
      req('GET', { host: 'localhost:3000', origin: 'http://localhost:8080' }),
      cfg,
      { upgrade: true },
    )
    expect(verdict).toMatchObject({ ok: false, status: 403, error: 'cross_origin' })
  })

  test('should allow WS upgrade same-origin without custom header', () => {
    expect(
      checkRequest(req('GET', { host: 'localhost:3000', origin: 'http://localhost:3000' }), cfg, {
        upgrade: true,
      }).ok,
    ).toBe(true)
  })
})

describe('mutation boundary', () => {
  test('should allow GET without request header', () => {
    expect(checkRequest(req('GET', { host: 'localhost:3000' }), cfg).ok).toBe(true)
  })

  test('should require custom header on POST', () => {
    expect(checkRequest(req('POST', { host: 'localhost:3000', origin: 'http://localhost:3000' }), cfg).ok).toBe(false)
    expect(
      checkRequest(req('POST', { host: 'localhost:3000', origin: 'http://localhost:3000', 'x-workmux-request': '1' }), cfg).ok,
    ).toBe(true)
  })

  test('should reject cross-origin mutation even with header', () => {
    const verdict = checkRequest(req('POST', { host: 'localhost:3000', origin: 'http://evil.test', 'x-workmux-request': '1' }), cfg)
    expect(verdict).toMatchObject({ ok: false, status: 403, error: 'cross_origin' })
  })

  test('should reject forbidden host before anything else', () => {
    expect(checkRequest(req('GET', { host: 'evil.test' }), cfg)).toMatchObject({ ok: false, error: 'forbidden_host' })
  })

  test('should enforce origin on websocket upgrades', () => {
    expect(checkRequest(req('GET', { host: 'localhost:3000', origin: 'http://evil.test' }), cfg, { upgrade: true }).ok).toBe(false)
    expect(checkRequest(req('GET', { host: 'localhost:3000' }), cfg, { upgrade: true }).ok).toBe(true)
  })
})

describe('bind policy', () => {
  test('should refuse wildcard bind', () => {
    expect(() => loadConfig({ WORKMUX_HTTP_BIND: '0.0.0.0' })).toThrow(/wildcard/)
    expect(() => loadConfig({ WORKMUX_HTTP_BIND: '::' })).toThrow(/wildcard/)
  })

  test('should accept wildcard bind with explicit opt-in', () => {
    expect(loadConfig({ WORKMUX_HTTP_BIND: '0.0.0.0', WORKMUX_HTTP_ALLOW_WILDCARD: '1' }).bind).toBe('0.0.0.0')
  })

  test('should keep host allowlist enforced with wildcard bind', () => {
    const cfg = loadConfig({
      WORKMUX_HTTP_BIND: '0.0.0.0',
      WORKMUX_HTTP_ALLOW_WILDCARD: '1',
      WORKMUX_ALLOWED_HOSTS: 'vpn.example.ts.net',
    })
    expect(hostAllowed('vpn.example.ts.net', cfg)).toBe(true)
    expect(hostAllowed('evil.example.com', cfg)).toBe(false)
  })
})
