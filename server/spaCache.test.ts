import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from './index.js'
import { loadConfig } from './config.js'

/**
 * Cache contract: HTML is never cached (Safari must always revalidate the
 * document that pins the bundle); hashed assets are cached immutably.
 */

const publicDir = path.join(process.cwd(), 'dist', 'public')
const skip = !existsSync(path.join(publicDir, 'index.html'))

describe('spa cache headers', { skip }, () => {
  const app = buildApp(loadConfig({ WORKMUX_ALLOWED_HOSTS: 'localhost' })).app

  it('serves the SPA document with no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.headers['cache-control']).toContain('no-cache')
    expect(res.headers['pragma']).toBe('no-cache')
  })

  it('serves SPA fallback routes with no-store too', async () => {
    const res = await app.inject({ method: 'GET', url: '/some/spa/route', headers: { host: 'localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('serves hashed assets immutably', async () => {
    const asset = readdirSync(path.join(publicDir, 'assets')).find((f) => f.endsWith('.js'))
    expect(asset).toBeTruthy()
    const res = await app.inject({ method: 'GET', url: `/assets/${asset}`, headers: { host: 'localhost' } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('max-age=31536000')
    expect(res.headers['cache-control']).toContain('immutable')
  })
})
