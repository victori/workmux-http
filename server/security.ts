import type { AppConfig } from './config.js'

export interface RequestLike {
  method: string
  headers: {
    host?: string
    origin?: string
    'x-workmux-request'?: string
  }
}

const SAFE_HOSTNAMES: Record<string, true> = { localhost: true, '127.0.0.1': true, '::1': true }
const MUTATION_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true }

export function hostAllowed(hostHeader: string | undefined, cfg: AppConfig): boolean {
  if (!hostHeader) return false
  let hostname = hostHeader
  try {
    hostname = new URL(`http://${hostHeader}`).hostname
  } catch {
    return false
  }
  if (cfg.allowAnyHost) return true
  if (hostname in SAFE_HOSTNAMES) return true
  if (hostname === cfg.bind) return true
  return cfg.allowedHosts.includes(hostname)
}

function originAuthority(origin: string): string | null {
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.host // host:port with scheme-default ports omitted
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

/** Same-origin check: Origin (when present) must match host AND port. */
export function originMatches(req: RequestLike, cfg: AppConfig): boolean {
  const origin = req.headers.origin
  if (!origin) return true // non-browser clients send no Origin
  const host = req.headers.host
  if (!host) return false
  const oa = originAuthority(origin)
  if (oa === null) return false
  const ra = requestAuthority(host)
  if (ra === null) return false
  return oa === ra
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
  const isMutation = req.method in MUTATION_METHODS || opts.upgrade === true
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
