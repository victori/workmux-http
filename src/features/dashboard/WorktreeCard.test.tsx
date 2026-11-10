// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeView } from '@shared/types'
import { WorktreeCard } from './WorktreeCard'

afterEach(cleanup)

function wt(overrides: Partial<WorktreeView> = {}): WorktreeView {
  return {
    id: 'wt_1',
    project: 'dc',
    projectPath: '/srv/dc',
    handle: 'api',
    branch: 'feat/x',
    path: '/srv/dc/api',
    isMain: false,
    mode: 'window',
    hasUncommittedChanges: false,
    isOpen: true,
    agentStatuses: [],
    createdAt: 0,
    prUrl: null,
    unpushed: 2,
    ...overrides,
  }
}

describe('WorktreeCard remote badges', () => {
  it('renders per-remote pills with counts and hides remotes that are up to date', () => {
    render(
      <WorktreeCard
        worktree={wt({
          remotes: [
            { name: 'origin', url: 'u1', hasRef: true, unpushed: 2, behind: 0, upstream: true },
            { name: 'github', url: 'u2', hasRef: true, unpushed: 0, behind: 0, upstream: false },
            { name: 'backup', url: 'u3', hasRef: false, unpushed: null, behind: null, upstream: false },
          ],
        })}
        selected={false}
        onOpenDiff={vi.fn()}
      />,
    )
    expect(screen.getByTitle('2 unpushed commits to origin')).toHaveTextContent('origin ↑2')
    expect(screen.getByTitle('never pushed to backup')).toHaveTextContent('backup new')
    expect(screen.queryByText(/github ↑/)).not.toBeInTheDocument()
  })

  it('falls back to the aggregate pill when per-remote state is absent', () => {
    render(<WorktreeCard worktree={wt()} selected={false} onOpenDiff={vi.fn()} />)
    expect(screen.getByTitle('2 unpushed commits')).toHaveTextContent('↑2')
  })

  it('renders no badge when every remote is up to date', () => {
    render(
      <WorktreeCard
        worktree={wt({
          unpushed: 0,
          remotes: [{ name: 'origin', url: 'u1', hasRef: true, unpushed: 0, behind: 0, upstream: true }],
        })}
        selected={false}
        onOpenDiff={vi.fn()}
      />,
    )
    expect(screen.queryByTitle(/unpushed|never pushed/)).not.toBeInTheDocument()
  })
})
