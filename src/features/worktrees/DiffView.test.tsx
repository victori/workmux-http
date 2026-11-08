import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot, DiffResponse, OperationView, PreparedAction } from '@shared/types'
import { api } from '../../lib/api'
import { DiffView } from './DiffView'

afterEach(cleanup)

vi.mock('../../lib/api', () => ({
  api: {
    diff: vi.fn(),
    dashboard: vi.fn(),
    hunkAction: vi.fn(),
    hunkComment: vi.fn(),
    message: vi.fn(),
    prepare: vi.fn(),
    execute: vi.fn(),
    operation: vi.fn(),
  },
}))

const mockApi = vi.mocked(api)

const wipDiff: DiffResponse = {
  worktreeId: 'wt_1',
  mode: 'wip',
  base: 'main',
  baseMissing: false,
  unborn: false,
  snapshotId: 'snap1',
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      binary: false,
      additions: 2,
      deletions: 1,
      hunks: [
        {
          index: 0,
          file: 'src/a.ts',
          header: '@@ -1,3 +1,4 @@',
          oldStart: 1,
          newStart: 1,
          oldCount: 3,
          newCount: 4,
          splittable: false,
          text: ' context line\n+added line\n-removed line',
        },
      ],
      diff: '',
    },
  ],
  untracked: [],
  truncated: false,
  observedAt: 1,
}

const snapshot: DashboardSnapshot = {
  observedAt: 1,
  agents: [
    {
      id: '%1',
      name: 'codex',
      project: 'proj',
      projectPath: '/p',
      worktreeId: 'wt_1',
      status: 'working',
      elapsedSecs: 5,
      title: null,
      agentKind: null,
      session: 's',
      windowName: null,
      workdir: '/p',
      git: null,
      updatedTs: 1,
    },
  ],
  worktrees: [
    {
      id: 'wt_1',
      project: 'proj',
      projectPath: '/p',
      handle: 'feat',
      branch: 'feat',
      path: '/p/.wt/feat',
      isMain: false,
      mode: 'window',
      hasUncommittedChanges: true,
      isOpen: true,
      agentStatuses: ['working'],
      createdAt: 1,
      prUrl: null,
    },
  ],
  sources: {
    workmuxList: { ok: true, at: 1 },
    workmuxStatus: { ok: true, at: 1 },
    tmux: { ok: true, at: 1 },
    git: { ok: true, at: 1 },
  },
  stale: false,
}

function renderView(): void {
  render(<DiffView worktreeId="wt_1" label="proj/feat" onClose={() => {}} connection="online" />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.diff.mockResolvedValue(wipDiff)
  mockApi.dashboard.mockResolvedValue(snapshot)
  mockApi.hunkAction.mockResolvedValue({ ok: true, snapshotStale: false })
})

describe('DiffView', () => {
  it('renders files and hunks from the diff response', async () => {
    renderView()
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
    expect(screen.getByText('Hunk 1 · @@ -1,3 +1,4 @@')).toBeInTheDocument()
    expect(screen.getByText('+added line')).toBeInTheDocument()
    expect(screen.getByText('-removed line')).toBeInTheDocument()
    expect(mockApi.diff).toHaveBeenCalledWith('wt_1', 'wip')
  })

  it('refetches with branch mode when Review is selected', async () => {
    renderView()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(mockApi.diff).toHaveBeenCalledWith('wt_1', 'branch'))
  })

  it('shows explicit base-missing message in review mode without assuming main', async () => {
    mockApi.diff.mockImplementation(async (_id, mode) =>
      mode === 'branch' ? { ...wipDiff, mode: 'branch', base: null, baseMissing: true, files: [] } : wipDiff,
    )
    renderView()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(await screen.findByText(/Base branch not configured/)).toBeInTheDocument()
    expect(screen.queryByText('Hunk 1 · @@ -1,3 +1,4 @@')).not.toBeInTheDocument()
  })

  it('stages a hunk with snapshotId+file+hunkIndex and refetches', async () => {
    renderView()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }))
    await waitFor(() =>
      expect(mockApi.hunkAction).toHaveBeenCalledWith('wt_1', 'stage', {
        snapshotId: 'snap1',
        file: 'src/a.ts',
        hunkIndex: 0,
      }),
    )
    await waitFor(() => expect(mockApi.diff).toHaveBeenCalledTimes(2))
  })

  it('shows reload notice and refetches when snapshot is stale', async () => {
    mockApi.hunkAction.mockResolvedValue({ ok: false, snapshotStale: true })
    renderView()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }))
    expect(await screen.findByText('diff changed, reloaded')).toBeInTheDocument()
    await waitFor(() => expect(mockApi.diff).toHaveBeenCalledTimes(2))
  })

  it('merge opens ConfirmDialog with exact target label and executes with confirmToken', async () => {
    const prepared: PreparedAction = {
      action: 'merge',
      targetId: 'wt_1',
      targetLabel: 'proj/feat → main',
      requiresConfirmation: true,
      warnings: ['worktree has uncommitted changes'],
      confirmToken: 'tok123',
    }
    const doneOp: OperationView = {
      id: 'op1',
      kind: 'merge',
      target: 'wt_1',
      state: 'done',
      output: 'merged ok',
      error: null,
      startedAt: 1,
      endedAt: 2,
    }
    mockApi.prepare.mockResolvedValue(prepared)
    mockApi.execute.mockResolvedValue(doneOp)

    renderView()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('proj/feat → main')).toBeInTheDocument()
    expect(within(dialog).getByText('worktree has uncommitted changes')).toBeInTheDocument()

    const mergeButton = within(dialog).getByRole('button', { name: 'Merge' })
    expect(mergeButton).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /accept these warnings/i }))
    expect(mergeButton).toBeEnabled()
    fireEvent.click(mergeButton)

    await waitFor(() =>
      expect(mockApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'merge',
          targetId: 'wt_1',
          confirmToken: 'tok123',
          acceptWarnings: true,
        }),
      ),
    )
  })
})
