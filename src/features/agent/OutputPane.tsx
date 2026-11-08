import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { AnsiUp } from 'ansi_up'
import type { AgentView } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { loadPref, savePref } from '../../lib/storage'

const POLL_MS = 2000
/** Auto-scroll only while the user is this close to the bottom. */
const FOLLOW_PX = 40

/** Named Reader text-size presets; stored key is validated against these. */
const TEXT_SIZES = { small: 11, normal: 12, large: 14, huge: 16 } as const
type TextSize = keyof typeof TEXT_SIZES
const TEXT_SIZE_ORDER: TextSize[] = ['small', 'normal', 'large', 'huge']
const DEFAULT_TEXT_SIZE: TextSize = 'normal'

function loadTextSize(): TextSize {
  const stored = loadPref<string>('textSize', DEFAULT_TEXT_SIZE)
  return stored in TEXT_SIZES ? (stored as TextSize) : DEFAULT_TEXT_SIZE
}

/**
 * Reader pane for an agent's terminal screen snapshot. The response is a full
 * screen: content is replaced wholesale each poll, and identical text skips the
 * DOM update so text selection survives. This is a live snapshot, not a
 * conversation log — wrapping may break TUI borders (disclosed in the UI).
 * While inactive (Terminal mode), polling pauses and late responses are
 * dropped; scroll/follow state persists for the return.
 */
export function OutputPane({
  agent,
  active,
  onOpenSwitcher,
  outputRef,
}: {
  agent: AgentView | null
  /** False while Terminal owns the screen: polling pauses, late responses ignored. */
  active: boolean
  onOpenSwitcher: () => void
  outputRef?: MutableRefObject<string>
}) {
  const ansi = useMemo(() => new AnsiUp(), [])
  const [html, setHtml] = useState('')
  const [targetGone, setTargetGone] = useState(false)
  const [outputError, setOutputError] = useState<string | null>(null)
  const [wrap, setWrap] = useState<boolean>(() => loadPref<boolean>('wrap', true))
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize)
  const [showJump, setShowJump] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastTextRef = useRef('')
  const inFlightRef = useRef(false)

  const agentId = agent?.id ?? null

  useEffect(() => {
    lastTextRef.current = ''
    followRef.current = true
    setShowJump(false)
    setTargetGone(false)
    setOutputError(null)
    setHtml('')
    if (outputRef) outputRef.current = ''
  }, [agentId, outputRef])

  useEffect(() => {
    if (!agentId || !active) return
    let cancelled = false

    const fetchOnce = () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      api
        .output(agentId)
        .then((res) => {
          if (cancelled) return
          setTargetGone(false)
          setOutputError(null)
          if (outputRef) outputRef.current = res.text
          // Identical screen: skip the update to preserve selection.
          if (res.text === lastTextRef.current) return
          lastTextRef.current = res.text
          setHtml(ansi.ansi_to_html(res.text))
        })
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof ApiError && (err.status === 410 || err.status === 404)) {
            setTargetGone(true)
            return
          }
          // Transient failure: keep the last snapshot on screen, say so.
          setOutputError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) inFlightRef.current = false
        })
    }

    fetchOnce()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') fetchOnce()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchOnce()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      inFlightRef.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [agentId, active, ansi, outputRef])

  // Follow the bottom only when the user hasn't scrolled away.
  useEffect(() => {
    const el = boxRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [html])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX
    followRef.current = near
    setShowJump(!near)
  }

  const jumpToLatest = () => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
    followRef.current = true
    setShowJump(false)
  }

  const toggleWrap = () => {
    setWrap((w) => {
      savePref('wrap', !w)
      return !w
    })
  }

  const stepTextSize = (delta: 1 | -1) => {
    setTextSize((s) => {
      const idx = Math.min(TEXT_SIZE_ORDER.length - 1, Math.max(0, TEXT_SIZE_ORDER.indexOf(s) + delta))
      const next = TEXT_SIZE_ORDER[idx]!
      savePref('textSize', next)
      return next
    })
  }

  if (targetGone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
        <p className="text-sm font-medium text-err">target ended</p>
        <p className="text-xs text-fg-muted">This agent&apos;s pane no longer exists.</p>
        <button onClick={onOpenSwitcher} className="rounded-lg border border-line px-4 py-2 text-sm text-accent">
          Switch agent
        </button>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-line bg-surface px-2 py-1">
        <div className="flex items-center gap-1" role="group" aria-label="Text size">
          <button
            onClick={() => stepTextSize(-1)}
            disabled={textSize === TEXT_SIZE_ORDER[0]}
            aria-label="Decrease text size"
            className="min-h-0 rounded-md px-2 py-1 text-xs text-fg-muted"
          >
            A−
          </button>
          <span className="min-w-10 text-center text-[10px] uppercase tracking-wide text-fg-muted">
            {textSize}
          </span>
          <button
            onClick={() => stepTextSize(1)}
            disabled={textSize === TEXT_SIZE_ORDER[TEXT_SIZE_ORDER.length - 1]}
            aria-label="Increase text size"
            className="min-h-0 rounded-md px-2 py-1 text-xs text-fg-muted"
          >
            A+
          </button>
        </div>
        <button
          onClick={toggleWrap}
          aria-pressed={wrap}
          aria-label={wrap ? 'Wrap lines on — may break TUI borders' : 'Wrap lines off — horizontal scroll keeps alignment'}
          title={
            wrap
              ? 'Snapshot of the terminal screen; wrapping may break TUI borders and tables'
              : 'Aligned tables and source keep columns; swipe to scroll'
          }
          className="min-h-0 rounded-md px-2 py-1 text-xs text-fg-muted"
        >
          {wrap ? '↩ wrap on' : '↔ wrap off'}
        </button>
      </div>
      {outputError && (
        <div role="status" aria-live="polite" className="shrink-0 bg-warn/10 px-3 py-1.5 text-xs text-warn">
          output unavailable ({outputError}) — showing last snapshot
        </div>
      )}
      <div
        ref={boxRef}
        onScroll={onScroll}
        className={`terminal-output min-h-0 min-w-0 flex-1 overflow-auto p-3 ${wrap ? '' : 'no-wrap'}`}
        style={{ fontSize: TEXT_SIZES[textSize] }}
      >
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {showJump && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-accent/40 bg-surface px-4 py-2 text-xs font-medium text-accent shadow-lg"
        >
          Jump to latest
        </button>
      )}
    </div>
  )
}
