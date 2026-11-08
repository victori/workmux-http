// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, newRequestId } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('newRequestId', () => {
  it('returns unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()))
    expect(ids.size).toBe(100)
  })

  it('works when crypto.randomUUID is unavailable (non-secure context)', () => {
    const partial = { randomUUID: undefined } as unknown as Crypto
    vi.stubGlobal('crypto', partial)
    const id = newRequestId()
    expect(id).toMatch(/^r-[0-9a-z]+-[0-9a-z]+$/)
    expect(new Set([newRequestId(), newRequestId(), id]).size).toBe(3)
  })

  it('works when crypto.randomUUID throws', () => {
    const partial = { randomUUID: () => { throw new Error('secure contexts only') } } as unknown as Crypto
    vi.stubGlobal('crypto', partial)
    expect(newRequestId()).toMatch(/^r-/)
  })
})

describe('read deadline (audit F11)', () => {
  it('aborts a never-resolving dashboard read via the timeout signal', async () => {
    const realFetch = globalThis.fetch
    const ctrl = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ctrl.signal)
    try {
      globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError')),
          )
        })) as typeof fetch
      const p = api.dashboard().catch((err: unknown) => err)
      ctrl.abort() // simulate the deadline firing
      const err = await p
      expect(err).toBeInstanceOf(DOMException)
      expect(spy).toHaveBeenCalledWith(15000)
    } finally {
      globalThis.fetch = realFetch
      spy.mockRestore()
    }
  })

  it('sends no abort signal on mutations', async () => {
    const realFetch = globalThis.fetch
    let sawSignal: AbortSignal | undefined = 'unset' as unknown as AbortSignal
    try {
      globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
        sawSignal = init?.signal
        return Promise.resolve(
          new Response(JSON.stringify({ delivered: 'sent', paneId: '%1', requestId: 'r' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }) as typeof fetch
      await api.message('%1', 'hi', 'r-1')
      expect(sawSignal).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
