import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { AnsiUp } from 'ansi_up'
import type { AgentView } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { loadPref, savePref } from '../../lib/storage'

const POLL_MS = 2000
/** Auto-scroll only while the user is this close to the bottom. */
const FOLLOW_PX = 40

/**
 * Polling pane for an agent's terminal screen. The response is a full screen
 * snapshot: content is replaced wholesale each poll, and identical text skips
 * the DOM update so text selection survives.
 */
export function OutputPane({
  agent,
  onOpenSwitcher,
  outputRef,
}: {
  agent: AgentView | null
  onOpenSwitcher: () => void
  outputRef?: MutableRefObject<string>
}) {
  const ansi = useMemo(() => new AnsiUp(), [])
  const [html, setHtml] = useState('')
  const [targetGone, setTargetGone] = useState(false)
  const [wrap, setWrap] = useState<boolean>(() => loadPref<boolean>('wrap', true))
  const [showJump, setShowJump] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastTextRef = useRef('')

  const agentId = agent?.id ?? null

  useEffect(() => {
    lastTextRef.current = ''
    followRef.current = true
    setShowJump(false)
    setTargetGone(false)
    setHtml('')
    if (outputRef) outputRef.current = ''
  }, [agentId, outputRef])

  useEffect(() => {
    if (!agentId) return
    let cancelled = false

    const fetchOnce = () => {
      api
        .output(agentId)
        .then((res) => {
          if (cancelled) return
          setTargetGone(false)
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
          }
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
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [agentId, ansi, outputRef])

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
    <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex justify-end border-b border-line bg-surface px-2 py-1">
        <button
          onClick={toggleWrap}
          aria-pressed={wrap}
          className="min-h-0 rounded-md px-2 py-1 text-xs text-fg-muted"
        >
          {wrap ? '↩ wrap on' : '↔ wrap off'}
        </button>
      </div>
      <div
        ref={boxRef}
        onScroll={onScroll}
        className={`terminal-output flex-1 overflow-auto p-3 ${wrap ? '' : 'no-wrap'}`}
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
