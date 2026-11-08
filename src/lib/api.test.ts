// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newRequestId } from './api'

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
