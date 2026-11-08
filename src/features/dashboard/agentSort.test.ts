import { describe, expect, it } from 'vitest'
import type { AgentView, WorktreeView } from '@shared/types'
import { filterAgents, filterWorktrees, humanizeElapsed, sortAgents, truncateMiddle } from './agentSort'

function agent(over: Partial<AgentView> & { id: string }): AgentView {
  return {
    name: over.id,
    project: 'proj',
    projectPath: `/src/${over.id}`,
    worktreeId: `wt_${over.id}`,
    status: 'working',
    elapsedSecs: 60,
    title: null,
    agentKind: null,
    session: 'sess',
    windowName: null,
    workdir: `/src/${over.id}`,
    git: null,
    updatedTs: 0,
    ...over,
  }
}

function worktree(over: Partial<WorktreeView> & { id: string }): WorktreeView {
  return {
    project: 'proj',
    projectPath: '/src/proj',
    handle: over.id,
    branch: `branch-${over.id}`,
    path: `/src/proj/${over.id}`,
    isMain: false,
    mode: 'window',
    hasUncommittedChanges: false,
    isOpen: true,
    agentStatuses: [],
    createdAt: 0,
    unpushed: null,
    prUrl: null,
    ...over,
  }
}

describe('humanizeElapsed', () => {
  it('formats seconds, minutes, hours, days', () => {
    expect(humanizeElapsed(42)).toBe('42s')
    expect(humanizeElapsed(300)).toBe('5m')
    expect(humanizeElapsed(10800)).toBe('3h')
    expect(humanizeElapsed(172800)).toBe('2d')
    expect(humanizeElapsed(0)).toBe('0s')
  })
})

describe('truncateMiddle', () => {
  it('keeps head and tail with an ellipsis', () => {
    const out = truncateMiddle('/Users/victori/Desktop/workmux-http/features', 20)
    expect(out.length).toBe(20)
    expect(out).toContain('…')
    expect(out.startsWith('/Users')).toBe(true)
    expect(out.endsWith('tures')).toBe(true)
  })

  it('leaves short strings alone', () => {
    expect(truncateMiddle('short/path', 34)).toBe('short/path')
  })
})

describe('sortAgents', () => {
  const list = [
    agent({ id: 'w', status: 'working' }),
    agent({ id: 's', status: 'stale' }),
    agent({ id: 'wa', status: 'waiting' }),
    agent({ id: 'd', status: 'done' }),
  ]

  it('priority: waiting > done > working > stale', () => {
    expect(sortAgents(list, 'priority').map((a) => a.id)).toEqual(['wa', 'd', 'w', 's'])
  })

  it('project: groups by project then priority inside', () => {
    const mixed = [
      agent({ id: 'b1', project: 'beta', status: 'working' }),
      agent({ id: 'a1', project: 'alpha', status: 'stale' }),
      agent({ id: 'a2', project: 'alpha', status: 'waiting' }),
      agent({ id: 'b2', project: 'beta', status: 'waiting' }),
    ]
    expect(sortAgents(mixed, 'project').map((a) => a.id)).toEqual(['a2', 'a1', 'b2', 'b1'])
  })

  it('recency: updatedTs descending', () => {
    const mixed = [
      agent({ id: 'old', updatedTs: 100 }),
      agent({ id: 'new', updatedTs: 300 }),
      agent({ id: 'mid', updatedTs: 200 }),
    ]
    expect(sortAgents(mixed, 'recency').map((a) => a.id)).toEqual(['new', 'mid', 'old'])
  })

  it('natural: input (tmux pane) order preserved', () => {
    expect(sortAgents(list, 'natural').map((a) => a.id)).toEqual(['w', 's', 'wa', 'd'])
  })
})

describe('filterAgents', () => {
  const list = [
    agent({ id: 'a1', project: 'Alpha', name: 'Coder' }),
    agent({ id: 'a2', project: 'beta', name: 'writer', status: 'stale' }),
  ]

  it('search is case-insensitive across project and name', () => {
    expect(filterAgents(list, { query: 'ALPHA' }).map((a) => a.id)).toEqual(['a1'])
    expect(filterAgents(list, { query: 'wri' }).map((a) => a.id)).toEqual(['a2'])
    expect(filterAgents(list, { query: '' })).toHaveLength(2)
  })

  it('hideStale removes stale agents', () => {
    expect(filterAgents(list, { hideStale: true }).map((a) => a.id)).toEqual(['a1'])
  })

  it('session filter keeps only that session', () => {
    const mixed = [agent({ id: 'x', session: 's1' }), agent({ id: 'y', session: 's2' })]
    expect(filterAgents(mixed, { session: 's1' }).map((a) => a.id)).toEqual(['x'])
    expect(filterAgents(mixed, { session: null })).toHaveLength(2)
  })
})

describe('filterWorktrees', () => {
  const list = [
    worktree({ id: 'w1', project: 'Alpha', handle: 'feat', branch: 'feature/x' }),
    worktree({ id: 'w2', project: 'beta', handle: 'fix', branch: 'bugfix/y', agentStatuses: ['stale'] }),
  ]

  it('search matches project, handle, or branch case-insensitively', () => {
    expect(filterWorktrees(list, { query: 'ALPHA' }).map((w) => w.id)).toEqual(['w1'])
    expect(filterWorktrees(list, { query: 'bugfix' }).map((w) => w.id)).toEqual(['w2'])
  })

  it('hideStale removes all-stale worktrees', () => {
    expect(filterWorktrees(list, { hideStale: true }).map((w) => w.id)).toEqual(['w1'])
  })
})
