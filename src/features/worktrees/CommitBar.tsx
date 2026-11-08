export interface CommitBarProps {
  /** Operator-configured command, e.g. `opencode-commit -a` or `git commit -m {{COMMIT_MSG}}`. */
  commitCmd: string
  busy: boolean
  /** False when the worktree has nothing to commit (staged/unstaged/untracked/conflicts). */
  hasChanges: boolean
  /** Failure surfaced inline under the bar (null while idle/running). */
  error: string | null
  onCommit: (message: string) => void
}

function Spinner() {
  return (
    <svg
      className="mr-1.5 inline h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Direct commit via the operator-configured command (index model): the
 * message is passed as one argv element; commit contents are exactly what
 * the index holds. Replaces the agent-commit button when configured.
 * Shows a spinner while the command runs and the failure inline when it
 * doesn't succeed.
 */
export function CommitBar({ commitCmd, busy, hasChanges, error, onCommit }: CommitBarProps) {
  const hasPlaceholder = commitCmd.includes('{{COMMIT_MSG}}')
  const submit = (el: HTMLTextAreaElement | null) => {
    if (!el || busy || !hasChanges) return
    onCommit(el.value.trim())
    el.value = ''
  }
  return (
    <div className="w-full">
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Commit message</span>
          <textarea
            rows={1}
            maxLength={4096}
            placeholder={`Commit message → ${commitCmd}${hasPlaceholder ? '' : ' {{COMMIT_MSG}}'}`}
            aria-label="Commit message"
            className="block min-h-[44px] w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-base leading-snug text-fg placeholder:text-fg-muted/60 md:text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e.currentTarget)
            }}
            id="wmhttp-commit-message"
          />
        </label>
        <button
          onClick={() => submit(document.getElementById('wmhttp-commit-message') as HTMLTextAreaElement | null)}
          disabled={busy || !hasChanges}
          aria-busy={busy}
          title={!hasChanges && !busy ? 'Nothing to commit — no staged, unstaged, or untracked changes' : undefined}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-60"
        >
          {busy && <Spinner />}
          {busy ? 'Committing…' : 'Commit now'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 whitespace-pre-wrap text-[11px] text-err">
          {error}
        </p>
      )}
    </div>
  )
}
