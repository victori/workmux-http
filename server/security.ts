import type { AppConfig } from './config.js'

export interface RequestLike {
  method: string
  headers: {
    host?: string
    origin?: string
    'x-workmux-request'?: string
  }
}

// Set (not object literal): `in`/`in obj` would accept inherited prototype
// keys like `constructor` and `__proto__` as allowed hosts/methods.
const SAFE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// This server speaks plain HTTP; a TLS-terminating proxy is not supported,
// so only http: Origins can be same-origin with the request target.
const SERVED_SCHEME = 'http:'

export function hostAllowed(hostHeader: string | undefined, cfg: AppConfig): boolean {
  if (!hostHeader) return false
  let hostname = hostHeader
  try {
    hostname = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  if (cfg.allowAnyHost) return true
  if (SAFE_HOSTNAMES.has(hostname)) return true
  if (hostname === cfg.bind) return true
  return cfg.allowedHosts.includes(hostname)
}

function originParts(origin: string): { scheme: string; authority: string } | null {
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return { scheme: u.protocol, authority: u.host } // host:port with scheme-default ports omitted
  } catch {
    return null
  }
}

function requestAuthority(hostHeader: string): string | null {
  try {
    const u = new URL(`http://${hostHeader}`)
    return u.port && u.port !== '80' ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return null
  }
}

/** Same-origin check: Origin (when present) must match scheme, host AND port. */
export function originMatches(req: RequestLike, cfg: AppConfig): boolean {
  const origin = req.headers.origin
  if (!origin) return true // non-browser clients send no Origin
  const host = req.headers.host
  if (!host) return false
  const oa = originParts(origin)
  if (oa === null) return false
  const ra = requestAuthority(host)
  if (ra === null) return false
  return oa.scheme === SERVED_SCHEME && oa.authority === ra
}

export interface SecurityVerdict {
  ok: boolean
  status?: 403 | 400
  error?: string
}

/**
 * API boundary: Host allowlist, same-origin for mutations/WS upgrades, and a
 * custom header requirement on JSON mutations (CSRF defense without login).
 */
export function checkRequest(
  req: RequestLike,
  cfg: AppConfig,
  opts: { upgrade?: boolean } = {},
): SecurityVerdict {
  if (!hostAllowed(req.headers.host, cfg)) {
    return { ok: false, status: 403, error: 'forbidden_host' }
  }
  const isMutation = MUTATION_METHODS.has(req.method) || opts.upgrade === true
  if (!isMutation) return { ok: true }
  if (!originMatches(req, cfg)) {
    return { ok: false, status: 403, error: 'cross_origin' }
  }
  if (opts.upgrade) return { ok: true }
  if (req.headers['x-workmux-request'] !== '1') {
    return { ok: false, status: 403, error: 'missing_request_header' }
  }
  return { ok: true }
}
