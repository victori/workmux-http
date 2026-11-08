// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentView, DeliveryResult } from '@shared/types'
import { api } from '../../lib/api'
import { Composer } from './Composer'

// vitest 3 + jsdom 27 on this toolchain don't expose Web Storage; shim it.
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
}
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true })
}

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, body: Record<string, unknown>) {
      super(String(body.error ?? `http ${status}`))
      this.status = status
      this.body = body
    }
  },
  api: {
    message: vi.fn(() =>
      Promise.resolve<DeliveryResult>({ delivered: 'sent', requestId: 'r', paneId: '%1' }),
    ),
    keys: vi.fn(() =>
      Promise.resolve<DeliveryResult>({ delivered: 'sent', requestId: 'r', paneId: '%1' }),
    ),
  },
}))

function agent(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    name: over.id,
    project: 'proj',
    projectPath: '/src/proj',
    worktreeId: `wt_${over.id}`,
    status: 'working',
    elapsedSecs: 10,
    title: null,
    agentKind: null,
    session: 'sess',
    windowName: null,
    workdir: '/src/proj',
    git: null,
    updatedTs: 0,
    ...over,
  }
}

const A = agent({ id: '%1', name: 'coder' })
const B = agent({ id: '%2', name: 'writer' })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.message).mockResolvedValue({ delivered: 'sent', requestId: 'r', paneId: '%1' })
})

afterEach(cleanup)

describe('Composer', () => {
  it('disables Send when offline', () => {
    render(<Composer agent={A} connection="offline" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hi' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('freezes the target id at submission and uses unique requestIds', async () => {
    let resolveSend: ((v: DeliveryResult) => void) | undefined
    vi.mocked(api.message).mockImplementationOnce(
      () =>
        new Promise<DeliveryResult>((r) => {
          resolveSend = r
        }),
    )
    const { rerender } = render(<Composer agent={A} connection="online" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Target switches while the request is still in flight.
    rerender(<Composer agent={B} connection="online" />)
    await act(async () => {
      resolveSend?.({ delivered: 'sent', requestId: 'r', paneId: '%1' })
    })

    expect(api.message).toHaveBeenCalledTimes(1)
    expect(api.message).toHaveBeenCalledWith('%1', 'do the thing', expect.any(String))
    const firstRequestId = vi.mocked(api.message).mock.calls[0]?.[2]

    // Second submission must carry a fresh requestId.
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(api.message).toHaveBeenCalledTimes(2)
    const secondRequestId = vi.mocked(api.message).mock.calls[1]?.[2]
    expect(secondRequestId).not.toBe(firstRequestId)
  })

  it('keeps drafts per target across switches', () => {
    const { rerender } = render(<Composer agent={A} connection="online" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'draft for A' } })

    rerender(<Composer agent={B} connection="online" />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')

    rerender(<Composer agent={A} connection="online" />)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('draft for A')
  })

  it('shows an uncertain-delivery banner without auto-retrying', async () => {
    vi.mocked(api.message).mockResolvedValueOnce({ delivered: 'unknown', requestId: 'r', paneId: '%1' })
    render(<Composer agent={A} connection="online" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'ping' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('delivery uncertain — check the agent')).toBeInTheDocument()
    expect(api.message).toHaveBeenCalledTimes(1)
  })
})
