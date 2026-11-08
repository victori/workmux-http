import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:4173'

test.describe('VPN request boundary', () => {
  test('should reject foreign Host header', async ({ request }) => {
    const res = await request.get(`${origin}/api/dashboard`, { headers: { host: 'evil.example.com' } })
    expect(res.status()).toBe(403)
    expect((await res.json()).error).toBe('forbidden_host')
  })

  test('should reject cross-origin mutation', async ({ request }) => {
    const res = await request.post(`${origin}/api/agents/%25287/messages`, {
      headers: { origin: 'http://evil.test', 'content-type': 'application/json', 'x-workmux-request': '1' },
      data: { text: 'x', requestId: 'e2e-1' },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).error).toBe('cross_origin')
  })

  test('should reject same-origin mutation without custom header', async ({ request }) => {
    const res = await request.post(`${origin}/api/agents/%25287/messages`, {
      headers: { origin, 'content-type': 'application/json' },
      data: { text: 'x', requestId: 'e2e-2' },
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).error).toBe('missing_request_header')
  })

  test('should accept proper same-origin mutation', async ({ request }) => {
    const res = await request.post(`${origin}/api/agents/%25287/messages`, {
      headers: { origin, 'content-type': 'application/json', 'x-workmux-request': '1' },
      data: { text: 'boundary ok', requestId: 'e2e-3' },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).delivered).toBe('sent')
  })

  test('should refuse unmanaged targets', async ({ request }) => {
    const res = await request.post(`${origin}/api/agents/%259999/messages`, {
      headers: { origin, 'content-type': 'application/json', 'x-workmux-request': '1' },
      data: { text: 'x', requestId: 'e2e-4' },
    })
    expect(res.status()).toBe(410)
  })

  test('should reject destructive execute without valid confirmation token', async ({ request }) => {
    const res = await request.post(`${origin}/api/actions/execute`, {
      headers: { origin, 'content-type': 'application/json', 'x-workmux-request': '1' },
      data: { action: 'remove', targetId: 'wt_deadbeefdead', confirmToken: 'forged', requestId: 'e2e-5' },
    })
    expect(res.status()).toBe(409)
  })
})
