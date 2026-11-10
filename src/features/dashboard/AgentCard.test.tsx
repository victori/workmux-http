// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentView, GithubStatus } from '@shared/types'
import { api } from '../../lib/api'
import { AgentCard } from './AgentCard'

afterEach(cleanup)

vi.mock('../../lib/api', async (orig) => ({...(await orig() as object),
  api: {
    diff: vi.fn(),
    dashboard: vi.fn(),
    hunkAction: vi.fn(),
    hunkComment: vi.fn(),
    message: vi.fn(),
    prepare: vi.fn(),
    execute: vi.fn(),
    operation: vi.fn(),
    addPaths: vi.fn(),
    commit: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`http ${status}`)
    }
  },
}))

const mockApi = vi.mocked(api)

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: '%1',
    name: 'dc-api',
    project: 'dc',
    projectPath: '/srv/dc',
    worktreeId: 'wt_1',
    status: 'waiting',
    elapsedSecs: 60,
    title: null,
    agentKind: 'claude',
    session: 's',
    windowName: 'w',
    workdir: '/srv/dc/api',
    git: {
      branch: 'main',
      hasStaged: false,
      hasUnstaged: false,
      hasUnmergedCommits: false,
      unborn: false,
      ahead: 2,
      behind: 0,
    },
    updatedTs: 1,
    ...overrides,
  }
}

const noop = () => undefined

describe('AgentCard push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the unpushed badge and push button when ahead > 0', () => {
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.getByTitle('2 unpushed commits')).toHaveTextContent('↑2')
    expect(screen.getByRole('button', { name: 'Push dc-api' })).toBeInTheDocument()
  })

  it('shows the pending-changes badge with the file count', () => {
    const a = agent()
    a.git = { ...a.git!, pendingChanges: 3 }
    render(<AgentCard agent={a} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.getByTitle('3 files pending commit')).toHaveTextContent('●3')
  })

  it('hides the pending badge at zero and without git info', () => {
    const a = agent()
    a.git = { ...a.git!, pendingChanges: 0 }
    render(<AgentCard agent={a} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.queryByTitle(/pending commit/)).not.toBeInTheDocument()
    const b = agent()
    b.git = null
    render(<AgentCard agent={b} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.queryByTitle(/pending commit/)).not.toBeInTheDocument()
  })

  it('hides badge and button when nothing is unpushed', () => {
    const a = agent()
    a.git = { ...a.git!, ahead: 0 }
    render(<AgentCard agent={a} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.queryByTitle(/unpushed/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument()
  })

  it('hides badge when git info is unavailable (no fabrication)', () => {
    const a = agent()
    a.git = null
    render(<AgentCard agent={a} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.queryByTitle(/unpushed/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /push/i })).not.toBeInTheDocument()
  })

  it('opens the confirm dialog listing commits before pushing', async () => {
    mockApi.prepare.mockResolvedValue({
      action: 'push',
      targetId: 'wt_1',
      targetLabel: 'dc/api [main]',
      requiresConfirmation: true,
      confirmToken: 'tok-1',
      warnings: ['remote has 1 newer commit(s); push will be rejected until you merge'],
      commits: [
        { sha: 'abc1234', subject: 'fix: second' },
        { sha: 'def5678', subject: 'feat: first' },
      ],
      commitsTruncated: false,
    })
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Push dc-api' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Push commits' })
    expect(within(dialog).getByText('2 commits to publish')).toBeInTheDocument()
    expect(within(dialog).getByText('fix: second')).toBeInTheDocument()
    expect(within(dialog).getByText('feat: first')).toBeInTheDocument()
    expect(mockApi.prepare).toHaveBeenCalledWith({ action: 'push', targetId: 'wt_1' })
  })

  it('executes with the token and reports success', async () => {
    mockApi.prepare.mockResolvedValue({
      action: 'push',
      targetId: 'wt_1',
      targetLabel: 'dc/api [main]',
      requiresConfirmation: true,
      confirmToken: 'tok-2',
      warnings: [],
      commits: [{ sha: 'abc1234', subject: 'feat: x' }],
    })
    mockApi.execute.mockResolvedValue({
      id: 'op-1',
      kind: 'push',
      target: 'api',
      state: 'running',
      output: null,
      error: null,
      startedAt: 1,
      endedAt: null,
    })
    mockApi.operation.mockResolvedValue({
      id: 'op-1',
      kind: 'push',
      target: 'api',
      state: 'done',
      output: 'abc1234..def5678 main -> origin/main',
      error: null,
      startedAt: 1,
      endedAt: 2,
    })
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Push dc-api' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Push commits' })
    // Push always gates on an explicit ack, even with zero warnings.
    const confirmBtn = within(dialog).getByRole('button', { name: 'Push now' })
    expect(confirmBtn).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /ready to push/ }))
    fireEvent.click(confirmBtn)
    // Dialog closes immediately; progress moves to the card.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('pushing…')
    await waitFor(() =>
      expect(mockApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'push', targetId: 'wt_1', confirmToken: 'tok-2' }),
      ),
    )
    expect(await screen.findByText(/✓ pushed.*main -> origin\/main/, {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('expands the full commit message on click and uses push-specific ack wording', async () => {
    mockApi.prepare.mockResolvedValue({
      action: 'push',
      targetId: 'wt_1',
      targetLabel: 'dc/api [main]',
      requiresConfirmation: true,
      confirmToken: 'tok-4',
      warnings: ['worktree has uncommitted changes'],
      commits: [
        { sha: 'abc1234', subject: 'feat: long one', body: 'detailed body line\n\nsecond para' },
        { sha: 'def5678', subject: 'chore: no body', body: '' },
      ],
    })
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Push dc-api' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Push commits' })
    expect(
      within(dialog).getByText('I confirm these commits are ready to push'),
    ).toBeInTheDocument()
    const row = within(dialog).getByRole('button', { name: /feat: long one/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row)
    expect(
      within(dialog).getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'detailed body line\n\nsecond para'),
    ).toBeInTheDocument()
    expect(row).toHaveAttribute('aria-expanded', 'true')
    // Commits without a body are not expandable.
    expect(within(dialog).queryByRole('button', { name: /chore: no body/ })).not.toBeInTheDocument()
    expect(within(dialog).getByText('chore: no body')).toBeInTheDocument()
  })

  it('surfaces push failure inline', async () => {
    mockApi.prepare.mockResolvedValue({
      action: 'push',
      targetId: 'wt_1',
      targetLabel: 'dc/api [main]',
      requiresConfirmation: true,
      confirmToken: 'tok-3',
      warnings: [],
      commits: [{ sha: 'a', subject: 'x' }],
    })
    mockApi.execute.mockResolvedValue({
      id: 'op-2',
      kind: 'push',
      target: 'api',
      state: 'running',
      output: null,
      error: null,
      startedAt: 1,
      endedAt: null,
    })
    mockApi.operation.mockResolvedValue({
      id: 'op-2',
      kind: 'push',
      target: 'api',
      state: 'failed',
      output: 'rejected (non-fast-forward)',
      error: 'push failed (exit 1): rejected (non-fast-forward)',
      startedAt: 1,
      endedAt: 2,
    })
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Push dc-api' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Push commits' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /ready to push/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Push now' }))
    expect(await screen.findByText(/non-fast-forward/, {}, { timeout: 3000 })).toBeInTheDocument()
  })
})

describe('AgentCard branch display', () => {
  it('shows the git branch in the meta row', () => {
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('omits the branch when git info is missing', () => {
    render(
      <AgentCard agent={agent({ git: null })} selected={false} onOpen={noop} onOpenTerminal={noop} />,
    )
    expect(screen.queryByText('main')).toBeNull()
  })
})

describe('AgentCard GitHub status', () => {
  it('renders PR status outside the navigation button without hijacking agent open', () => {
    const onOpen = vi.fn()
    const github: GithubStatus = {
      state: 'ready',
      pr: {
        number: 7,
        title: 'T',
        url: 'https://github.com/o/r/pull/7',
        state: 'open',
        review: 'approved',
        headOid: 'a'.repeat(40),
        headRepository: 'o/r',
        baseRepository: 'o/r',
        baseBranch: 'main',
      },
      ci: {
        state: 'passing',
        commitOid: 'a'.repeat(40),
        complete: true,
        counts: { passing: 1, failing: 0, pending: 0, neutral: 0, unknown: 0 },
        checks: [],
      },
      observedAt: Date.now(),
      attemptedAt: Date.now(),
      error: null,
    }
    render(<AgentCard agent={agent()} github={github} selected={false} onOpen={onOpen} onOpenTerminal={noop} />)
    const link = screen.getByRole('link', { name: /PR #7/ })
    expect(link.closest('button')).toBeNull()
    fireEvent.click(link)
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByText(/CI passing/)).toBeInTheDocument()
  })

  it('omits the status row when no GitHub status is provided', () => {
    render(<AgentCard agent={agent()} selected={false} onOpen={noop} onOpenTerminal={noop} />)
    expect(screen.queryByText(/PR #|No PR|GitHub/)).toBeNull()
  })
})
