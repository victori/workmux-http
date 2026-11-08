import { useEffect, useRef } from 'react'

export type AgentMode = 'reader' | 'terminal'

/**
 * Segmented Reader/Terminal mode control for the agent detail header.
 * Buttons with aria-pressed (no tab semantics without full tab keyboard
 * behavior). Returning to Reader from Terminal restores focus to the
 * Reader button; entering Terminal never steals focus toward input.
 */
export function ModeControl({
  mode,
  disabled,
  onChange,
}: {
  mode: AgentMode
  disabled: boolean
  onChange: (mode: AgentMode) => void
}) {
  const readerRef = useRef<HTMLButtonElement>(null)
  const prevMode = useRef<AgentMode>(mode)

  useEffect(() => {
    if (prevMode.current === 'terminal' && mode === 'reader') readerRef.current?.focus()
    prevMode.current = mode
  }, [mode])

  return (
    <div
      role="group"
      aria-label="Agent view mode"
      className="flex shrink-0 overflow-hidden rounded-lg border border-line"
    >
      <button
        ref={readerRef}
        type="button"
        aria-pressed={mode === 'reader'}
        disabled={disabled}
        onClick={() => onChange('reader')}
        className={`px-3 py-1.5 text-xs font-medium ${
          mode === 'reader' ? 'bg-accent text-bg' : 'bg-surface text-fg-muted'
        } disabled:opacity-45`}
      >
        Reader
      </button>
      <button
        type="button"
        aria-pressed={mode === 'terminal'}
        disabled={disabled}
        onClick={() => onChange('terminal')}
        className={`px-3 py-1.5 text-xs font-medium ${
          mode === 'terminal' ? 'bg-accent text-bg' : 'bg-surface text-fg-muted'
        } disabled:opacity-45`}
      >
        Terminal
      </button>
    </div>
  )
}
