import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentView, WorktreeView } from '@shared/types'

export interface CommandPaletteProps {
  agents: AgentView[]
  worktrees: WorktreeView[]
  onClose: () => void
  onOpenAgent: (id: string) => void
  onOpenDiff: (id: string, label: string) => void
  onCreate: () => void
  onGoPrevious: () => void
}

type Group = 'Agents' | 'Worktrees' | 'Actions'

interface Command {
  id: string
  group: Group
  label: string
  run: () => void
}

const GROUPS: Group[] = ['Agents', 'Worktrees', 'Actions']

export function CommandPalette({
  agents,
  worktrees,
  onClose,
  onOpenAgent,
  onOpenDiff,
  onCreate,
  onGoPrevious,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []
    for (const a of agents) {
      const label = `Open Agent ${a.project}/${a.name}`
      list.push({ id: `agent:${a.id}`, group: 'Agents', label, run: () => onOpenAgent(a.id) })
    }
    for (const w of worktrees) {
      const label = `Diff ${w.project}/${w.handle}`
      list.push({ id: `diff:${w.id}`, group: 'Worktrees', label, run: () => onOpenDiff(w.id, `${w.project}/${w.handle}`) })
    }
    list.push({ id: 'action:create', group: 'Actions', label: 'New worktree', run: onCreate })
    list.push({ id: 'action:previous', group: 'Actions', label: 'Previous agent', run: onGoPrevious })
    return list
  }, [agents, worktrees, onOpenAgent, onOpenDiff, onCreate, onGoPrevious])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? commands : commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    setSelected(0)
  }, [query])

  function runCommand(cmd: Command | undefined): void {
    if (!cmd) return
    cmd.run()
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || (!e.metaKey && !e.ctrlKey && e.key === 'j')) {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp' || (!e.metaKey && !e.ctrlKey && e.key === 'k')) {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runCommand(filtered[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-4 pt-[12vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search agents, worktrees, commands…"
          aria-label="Search commands"
          className="w-full border-b border-line bg-bg px-4 py-3 text-base text-fg placeholder:text-fg-muted/60 md:text-sm"
        />
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-fg-muted">No matching commands.</p>
        ) : (
          <ul role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto py-1 safe-bottom">
            {GROUPS.map((group) => {
              const items = filtered.filter((c) => c.group === group)
              if (items.length === 0) return null
              return (
                <li key={group}>
                  <div className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-fg-muted/70">{group}</div>
                  <ul>
                    {items.map((c) => {
                      const idx = filtered.indexOf(c)
                      const active = idx === selected
                      return (
                        <li key={c.id}>
                          <button
                            role="option"
                            aria-selected={active}
                            onClick={() => runCommand(c)}
                            onMouseEnter={() => setSelected(idx)}
                            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm ${
                              active ? 'bg-surface-2 text-accent' : 'text-fg'
                            }`}
                          >
                            {c.label}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
        <div className="border-t border-line px-4 py-1.5 text-[11px] text-fg-muted/60">↑↓/jk select · ⏎ run · esc close</div>
      </div>
    </div>
  )
}
