import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentView, WorktreeView } from '@shared/types'
import { CommandPalette } from './CommandPalette'

afterEach(cleanup)

const agent: AgentView = {
  id: '%42',
  name: 'codex',
  project: 'proj',
  projectPath: '/p',
  worktreeId: 'wt_1',
  status: 'working',
  elapsedSecs: 10,
  title: null,
  agentKind: null,
  session: 's',
  windowName: null,
  workdir: '/p',
  git: null,
  updatedTs: 1,
}

const worktree: WorktreeView = {
  id: 'wt_1',
  project: 'proj',
  projectPath: '/p',
  handle: 'feat-x',
  branch: 'feat-x',
  path: '/p/.wt/feat-x',
  isMain: false,
  mode: 'window',
  hasUncommittedChanges: false,
  isOpen: true,
  agentStatuses: ['working'],
  createdAt: 1,
  prUrl: null,
}

function renderPalette() {
  const props = {
    agents: [agent],
    worktrees: [worktree],
    onClose: vi.fn(),
    onOpenAgent: vi.fn(),
    onOpenDiff: vi.fn(),
    onCreate: vi.fn(),
    onGoPrevious: vi.fn(),
  }
  render(<CommandPalette {...props} />)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CommandPalette', () => {
  it('lists agents, worktrees and actions under group headers', () => {
    renderPalette()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Worktrees')).toBeInTheDocument()
    expect(screen.getByText('Actions')).toBeInTheDocument()
    expect(screen.getByText('Open Agent proj/codex')).toBeInTheDocument()
    expect(screen.getByText('Diff proj/feat-x')).toBeInTheDocument()
    expect(screen.getByText('New worktree')).toBeInTheDocument()
    expect(screen.getByText('Previous agent')).toBeInTheDocument()
  })

  it('filters case-insensitively by substring', () => {
    renderPalette()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'diff pr' } })
    expect(screen.getByText('Diff proj/feat-x')).toBeInTheDocument()
    expect(screen.queryByText('Open Agent proj/codex')).not.toBeInTheDocument()
    expect(screen.queryByText('New worktree')).not.toBeInTheDocument()
  })

  it('Enter runs the current selection and closes', () => {
    const props = renderPalette()
    const input = screen.getByRole('textbox')
    // initial selection is the first command (Open Agent)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onOpenAgent).toHaveBeenCalledWith('%42')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('j/k navigation + Enter runs the matching command', () => {
    const props = renderPalette()
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'j' }) // move from Open Agent to Diff worktree
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onOpenDiff).toHaveBeenCalledWith('wt_1', 'proj/feat-x')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('filtered Enter runs the action and Escape closes', () => {
    const props = renderPalette()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'new work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onCreate).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('clicking an option runs it and closes', () => {
    const props = renderPalette()
    fireEvent.click(screen.getByText('New worktree'))
    expect(props.onCreate).toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
  })
})
