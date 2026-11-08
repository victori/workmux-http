import type { Hunk } from '@shared/types'

export const hunkKey = (file: string, index: number) => `${file}:${index}`

function lineTone(line: string): string {
  if (line.startsWith('+')) return 'text-ok'
  if (line.startsWith('-')) return 'text-err'
  if (line.startsWith('@@')) return 'text-accent'
  return 'text-fg-muted'
}

/** Plain text nodes — React escapes diff content automatically. */
export function HunkBody({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-xs leading-5">
      {text.split('\n').map((line, i) => (
        <div key={i} className={lineTone(line)}>
          {line === '' ? ' ' : line}
        </div>
      ))}
    </pre>
  )
}

export interface HunkListProps {
  hunks: Hunk[]
  /** WIP patch mode: show per-hunk Stage/Skip/Split/Comment actions. */
  patchMode: boolean
  skipped: Set<string>
  stagedKeys: Set<string>
  stagedPieces: Set<string>
  pieces: Map<string, string[]>
  busyKey: string | null
  onStage(file: string, hunkIndex: number): void
  onUnstage(file: string, hunkIndex: number): void
  onStagePiece(file: string, hunkIndex: number, piece: string): void
  onUnstagePiece(file: string, hunkIndex: number, piece: string): void
  onSplit(file: string, hunkIndex: number): void
  onToggleSkip(file: string, hunkIndex: number): void
  onComment(file: string, hunkIndex: number): void
}

export function HunkList({
  hunks,
  patchMode,
  skipped,
  stagedKeys,
  stagedPieces,
  pieces,
  busyKey,
  onStage,
  onUnstage,
  onStagePiece,
  onUnstagePiece,
  onSplit,
  onToggleSkip,
  onComment,
}: HunkListProps) {
  return (
    <div className="space-y-3">
      {hunks.map((h) => {
        const key = hunkKey(h.file, h.index)
        const isSkipped = skipped.has(key)
        const isStaged = stagedKeys.has(key)
        const splitList = pieces.get(key)
        const busy = busyKey === key
        return (
          <section key={key} className={`rounded-lg border border-line ${isSkipped ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-1.5">
              <span className="min-w-0 truncate font-mono text-xs text-accent">
                Hunk {h.index + 1} · {h.header}
              </span>
              {isStaged && <span className="shrink-0 text-[11px] text-ok">staged</span>}
            </div>
            {!isSkipped && !splitList && <HunkBody text={h.text} />}
            {splitList && (
              <div className="divide-y divide-line">
                {splitList.map((piece, pi) => (
                  <div key={pi} className="px-1 py-1">
                    <div className="mb-1 flex items-center justify-between px-2">
                      <span className="text-[11px] text-fg-muted">piece {pi + 1}</span>
                      {stagedPieces.has(`${key}:${piece}`) ? (
                        <button
                          onClick={() => onUnstagePiece(h.file, h.index, piece)}
                          disabled={busy}
                          className="rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-2"
                        >
                          Undo
                        </button>
                      ) : (
                        <button
                          onClick={() => onStagePiece(h.file, h.index, piece)}
                          disabled={busy}
                          className="rounded-md border border-accent px-2 py-1 text-xs text-accent"
                        >
                          Stage
                        </button>
                      )}
                    </div>
                    <HunkBody text={piece} />
                  </div>
                ))}
              </div>
            )}
            {patchMode && (
              <div className="flex flex-wrap gap-1 border-t border-line px-2 py-1.5">
                {!splitList && (
                  <button
                    onClick={() => (isStaged ? onUnstage(h.file, h.index) : onStage(h.file, h.index))}
                    disabled={busy}
                    className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted hover:bg-surface-2"
                  >
                    {busy ? '…' : isStaged ? 'Undo' : 'Stage'}
                  </button>
                )}
                <button
                  onClick={() => onToggleSkip(h.file, h.index)}
                  className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted hover:bg-surface-2"
                >
                  {isSkipped ? 'Unskip' : 'Skip'}
                </button>
                {h.splittable && !splitList && (
                  <button
                    onClick={() => onSplit(h.file, h.index)}
                    disabled={busy}
                    className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted hover:bg-surface-2"
                  >
                    Split
                  </button>
                )}
                <button
                  onClick={() => onComment(h.file, h.index)}
                  className="rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted hover:bg-surface-2"
                >
                  Comment
                </button>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
