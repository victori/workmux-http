import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot, DiffResponse, OperationView, PreparedAction } from '@shared/types'
import { api } from '../../lib/api'
import { DiffView } from './DiffView'

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
    unstagePaths: vi.fn(),
    commit: vi.fn(),
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
  unstaged: [],
  staged: [],
  conflicts: [],
  hasStaged: false,
  pendingKnown: true,
  commitCmd: null,
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
      unpushed: null,
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
  mockApi.addPaths.mockResolvedValue({ ok: true })
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
    expect(mockApi.diff).toHaveBeenCalledWith('wt_1', 'wip', undefined)
  })

  it('refetches with branch mode when Review is selected', async () => {
    renderView()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(mockApi.diff).toHaveBeenCalledWith('wt_1', 'branch', undefined))
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

const pendingDiff: DiffResponse = {
  ...wipDiff,
  untracked: ['new1.txt'],
  unstaged: ['base.txt'],
  conflicts: ['clash.txt'],
  commitCmd: 'opencode-commit',
}

describe('DiffView pending changes and direct commit', () => {
  it('lists untracked, unstaged, and conflicts with add controls', async () => {
    mockApi.diff.mockResolvedValue(pendingDiff)
    renderView()
    const section = await screen.findByRole('region', { name: 'Pending changes' })
    expect(within(section).getByText('new1.txt')).toBeInTheDocument()
    expect(within(section).getByText('base.txt')).toBeInTheDocument()
    expect(within(section).getByText('clash.txt')).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: 'Add all (2)' }))
    expect(mockApi.addPaths).toHaveBeenCalledWith('wt_1', ['new1.txt', 'base.txt'])
    expect(mockApi.addPaths.mock.calls[0]![1]).not.toContain('clash.txt')
    expect(await screen.findByText('2 files staged')).toBeInTheDocument()
  })

  it('reports stale add offenders and reloads the diff', async () => {
    mockApi.diff.mockResolvedValue(pendingDiff)
    mockApi.addPaths.mockResolvedValue({ ok: false, message: 'paths are no longer pending', offenders: ['ghost.txt'] })
    renderView()
    const section = await screen.findByRole('region', { name: 'Pending changes' })
    fireEvent.click(within(section).getByRole('button', { name: 'Add all (2)' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/ghost\.txt/)
    await waitFor(() => expect(mockApi.diff.mock.calls.length).toBeGreaterThan(1))
  })

  it('replaces the agent commit button with CommitBar when a command is configured', async () => {
    mockApi.diff.mockResolvedValue(pendingDiff)
    mockApi.commit.mockResolvedValue({ operationId: 'op-9' })
    mockApi.operation.mockResolvedValue({
      id: 'op-9',
      kind: 'commit',
      target: 'feat',
      state: 'done',
      output: '1 file changed',
      error: null,
      startedAt: 1,
      endedAt: 2,
    })
    renderView()
    const input = await screen.findByRole('textbox', { name: 'Commit message' })
    expect(screen.queryByRole('button', { name: 'Commit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit now' })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'feat: direct' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit now' }))
    await waitFor(() => expect(mockApi.commit).toHaveBeenCalledWith('wt_1', 'feat: direct'))
    expect(await screen.findByText('committed')).toBeInTheDocument()
  })

  it('submits with an empty message when none is typed', async () => {
    mockApi.diff.mockResolvedValue(pendingDiff)
    mockApi.commit.mockResolvedValue({ operationId: 'op-12' })
    mockApi.operation.mockResolvedValue({
      id: 'op-12',
      kind: 'commit',
      target: 'feat',
      state: 'done',
      output: 'ok',
      error: null,
      startedAt: 1,
      endedAt: 2,
    })
    renderView()
    await screen.findByRole('textbox', { name: 'Commit message' })
    fireEvent.click(screen.getByRole('button', { name: 'Commit now' }))
    await waitFor(() => expect(mockApi.commit).toHaveBeenCalledWith('wt_1', ''))
    expect(await screen.findByText('committed')).toBeInTheDocument()
  })

  it('keeps the agent commit button when no command is configured', async () => {
    renderView()
    expect(await screen.findByRole('button', { name: 'Commit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Commit now' })).not.toBeInTheDocument()
  })

  it('disables Commit now when the worktree has no changes', async () => {
    mockApi.diff.mockResolvedValue({ ...pendingDiff, untracked: [], unstaged: [], conflicts: [], hasStaged: false })
    renderView()
    await screen.findByRole('textbox', { name: 'Commit message' })
    const btn = screen.getByRole('button', { name: 'Commit now' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringContaining('Nothing to commit'))
    fireEvent.click(btn)
    expect(mockApi.commit).not.toHaveBeenCalled()
  })

  it('enables Commit now when only staged changes exist', async () => {
    mockApi.diff.mockResolvedValue({ ...pendingDiff, untracked: [], unstaged: [], conflicts: [], hasStaged: true })
    renderView()
    await screen.findByRole('textbox', { name: 'Commit message' })
    expect(screen.getByRole('button', { name: 'Commit now' })).toBeEnabled()
  })

  it('keeps Commit now enabled when git status is unknown (degraded)', async () => {
    mockApi.diff.mockResolvedValue({
      ...pendingDiff,
      untracked: [],
      unstaged: [],
      conflicts: [],
      hasStaged: false,
      pendingKnown: false,
    })
    renderView()
    await screen.findByRole('textbox', { name: 'Commit message' })
    expect(screen.getByRole('button', { name: 'Commit now' })).toBeEnabled()
  })

  it('surfaces a failed commit operation with its error', async () => {
    mockApi.diff.mockResolvedValue(pendingDiff)
    mockApi.commit.mockResolvedValue({ operationId: 'op-10' })
    mockApi.operation.mockResolvedValue({
      id: 'op-10',
      kind: 'commit',
      target: 'feat',
      state: 'failed',
      output: null,
      error: 'commit failed (exit 1)',
      startedAt: 1,
      endedAt: 2,
    })
    renderView()
    const input = await screen.findByRole('textbox', { name: 'Commit message' })
    fireEvent.change(input, { target: { value: 'bad msg' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/commit failed \(exit 1\)/)
  })

  it('shows a busy spinner while the commit operation runs', async () => {
    mockApi.diff.mockResolvedValue(pendingDiff)
    mockApi.commit.mockResolvedValue({ operationId: 'op-11' })
    mockApi.operation
      .mockResolvedValueOnce({
        id: 'op-11',
        kind: 'commit',
        target: 'feat',
        state: 'running',
        output: null,
        error: null,
        startedAt: 1,
        endedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'op-11',
        kind: 'commit',
        target: 'feat',
        state: 'done',
        output: 'ok',
        error: null,
        startedAt: 1,
        endedAt: 2,
      })
    renderView()
    const input = await screen.findByRole('textbox', { name: 'Commit message' })
    fireEvent.change(input, { target: { value: 'feat: slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit now' }))
    const busyButton = await screen.findByRole('button', { name: /committing/i })
    expect(busyButton).toBeDisabled()
    expect(busyButton).toHaveAttribute('aria-busy', 'true')
    expect(await screen.findByText('committed', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit now' })).toBeEnabled()
  })
})

describe('staged rows (Restore)', () => {
  const stagedDiff: DiffResponse = {
    ...wipDiff,
    untracked: ['new1.txt'],
    staged: ['already-staged.txt'],
    hasStaged: true,
  }

  it('renders staged file with a Restore button and bulk Restore all', async () => {
    vi.spyOn(api, 'diff').mockResolvedValue(stagedDiff)
    render(<DiffView worktreeId="wt_1" label="proj/feat" onClose={() => {}} connection="online" />)
    expect(await screen.findByText('already-staged.txt')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restore already-staged\.txt/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore all (1)' })).toBeInTheDocument()
  })

  it('clicking Restore unstages just that file and reports it', async () => {
    const unstage = vi.spyOn(api, 'unstagePaths').mockResolvedValue({ ok: true })
    vi.spyOn(api, 'diff').mockResolvedValue(stagedDiff)
    render(<DiffView worktreeId="wt_1" label="proj/feat" onClose={() => {}} connection="online" />)
    fireEvent.click(await screen.findByRole('button', { name: /Restore already-staged\.txt/ }))
    expect(unstage).toHaveBeenCalledWith('wt_1', ['already-staged.txt'])
    expect(await screen.findByRole('status')).toHaveTextContent('1 file restored (unstaged)')
  })

  it('Restore all passes every staged path', async () => {
    const unstage = vi.spyOn(api, 'unstagePaths').mockResolvedValue({ ok: true })
    vi.spyOn(api, 'diff').mockResolvedValue({ ...stagedDiff, staged: ['a.txt', 'b.txt'] })
    render(<DiffView worktreeId="wt_1" label="proj/feat" onClose={() => {}} connection="online" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore all (2)' }))
    expect(unstage).toHaveBeenCalledWith('wt_1', ['a.txt', 'b.txt'])
  })

  it('Add flips to Restore after the file becomes staged', async () => {
    const afterAdd: DiffResponse = {
      ...wipDiff,
      untracked: [],
      staged: ['new1.txt'],
      hasStaged: true,
    }
    vi.spyOn(api, 'diff')
      .mockResolvedValueOnce({ ...wipDiff, untracked: ['new1.txt'] })
      .mockResolvedValue(afterAdd)
    vi.spyOn(api, 'addPaths').mockResolvedValue({ ok: true })
    render(<DiffView worktreeId="wt_1" label="proj/feat" onClose={() => {}} connection="online" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add new1.txt to commit' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 file staged')
    // reload reports new1.txt staged: same file now offers Restore, not Add
    expect(await screen.findByRole('button', { name: /Restore new1\.txt/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add new1.txt to commit' })).not.toBeInTheDocument()
  })

  it('reports offenders when paths are no longer staged', async () => {
    vi.spyOn(api, 'diff').mockResolvedValue(stagedDiff)
    vi.spyOn(api, 'unstagePaths').mockResolvedValue({
      ok: false,
      message: 'paths are not staged; refresh and retry',
      offenders: ['already-staged.txt'],
    })
    render(<DiffView worktreeId="wt_1" label="proj/feat" onClose={() => {}} connection="online" />)
    fireEvent.click(await screen.findByRole('button', { name: /Restore already-staged\.txt/ }))
    expect(await screen.findByRole('status')).toHaveTextContent('not staged')
    expect(await screen.findByRole('status')).toHaveTextContent('already-staged.txt')
  })
})

describe('commit mode (from Commits list)', () => {
  const commit = {
    sha: 'c'.repeat(40),
    short: 'ccccccc',
    author: 'Vic',
    dateSecs: 1780000000,
    subject: 'feat: shipped thing',
    isMerge: false,
  }
  const commitDiffResp: DiffResponse = {
    ...wipDiff,
    mode: 'commit',
    base: 'ccccccc',
    commit,
    untracked: [],
    staged: [],
    hasStaged: false,
  }

  it('loads the commit diff by sha and shows subject vs parent', async () => {
    const diff = vi.spyOn(api, 'diff').mockResolvedValue(commitDiffResp)
    render(<DiffView worktreeId="wt_1" label="proj/feat" commit={commit} onClose={() => {}} connection="online" />)
    expect(diff).toHaveBeenCalledWith('wt_1', 'commit', commit.sha)
    expect(await screen.findByText('feat: shipped thing')).toBeInTheDocument()
    expect(screen.getByText(/vs parent · Vic/)).toBeInTheDocument()
  })

  it('hides WIP/Review toggle and worktree actions in commit mode', async () => {
    vi.spyOn(api, 'diff').mockResolvedValue(commitDiffResp)
    render(<DiffView worktreeId="wt_1" label="proj/feat" commit={commit} onClose={() => {}} connection="online" /> )
    await screen.findByText('feat: shipped thing')
    expect(screen.queryByRole('group', { name: 'diff mode' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Merge/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Pending changes')).not.toBeInTheDocument()
  })

  it('back button returns to the commits list', async () => {
    vi.spyOn(api, 'diff').mockResolvedValue(commitDiffResp)
    const onClose = vi.fn()
    render(<DiffView worktreeId="wt_1" label="proj/feat" commit={commit} onClose={onClose} connection="online" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Close diff' }))
    expect(onClose).toHaveBeenCalled()
  })
})
