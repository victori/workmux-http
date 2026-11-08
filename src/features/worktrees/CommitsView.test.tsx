// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommitListResponse } from '@shared/types'
import { api } from '../../lib/api'
import { CommitsView } from './CommitsView'

afterEach(cleanup)

vi.mock('../../lib/api', async (orig) => ({...(await orig() as object),
  api: {
    commits: vi.fn(),
  },
}))

const list: CommitListResponse = {
  commits: [
    { sha: 'a'.repeat(40), short: 'aaaaaaa', author: 'Vic', dateSecs: Math.floor(Date.now() / 1000) - 120, subject: 'feat: add thing', isMerge: false },
    { sha: 'b'.repeat(40), short: 'bbbbbbb', author: 'Vic', dateSecs: Math.floor(Date.now() / 1000) - 7200, subject: 'merge side', isMerge: true },
  ],
  truncated: false,
}

const baseProps = {
  worktreeId: 'wt_1',
  label: 'proj/feat',
  connection: 'online' as const,
  onClose: () => {},
  onOpenCommit: () => {},
}

describe('CommitsView', () => {
  it('renders commit rows with sha, subject, author', async () => {
    vi.spyOn(api, 'commits').mockResolvedValue(list)
    render(<CommitsView {...baseProps} />)
    expect(await screen.findByText('feat: add thing')).toBeInTheDocument()
    expect(screen.getByText('aaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('merge side')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show diff for bbbbbbb: merge side' })).toBeInTheDocument()
  })

  it('opens the clicked commit', async () => {
    vi.spyOn(api, 'commits').mockResolvedValue(list)
    const onOpenCommit = vi.fn()
    render(<CommitsView {...baseProps} onOpenCommit={onOpenCommit} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show diff for aaaaaaa: feat: add thing' }))
    expect(onOpenCommit).toHaveBeenCalledWith(list.commits[0])
  })

  it('shows empty state for a repo without commits', async () => {
    vi.spyOn(api, 'commits').mockResolvedValue({ commits: [], truncated: false })
    render(<CommitsView {...baseProps} />)
    expect(await screen.findByText(/No commits yet/)).toBeInTheDocument()
  })

  it('surfaces errors with retry', async () => {
    vi.spyOn(api, 'commits')
      .mockRejectedValueOnce(new Error('git log failed'))
      .mockResolvedValueOnce(list)
    render(<CommitsView {...baseProps} />)
    expect(await screen.findByText('git log failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('feat: add thing')).toBeInTheDocument())
  })

  it('notes truncation beyond the page size', async () => {
    vi.spyOn(api, 'commits').mockResolvedValue({ ...list, truncated: true })
    render(<CommitsView {...baseProps} />)
    expect(await screen.findByText(/Showing the newest 2 commits/)).toBeInTheDocument()
  })
})
