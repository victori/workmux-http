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
 * Line layout modes:
 * - wrap: lines soft-wrap to the screen (prose-friendly; breaks TUI borders)
 * - fit: no wrap; font shrinks so the widest used column fits the screen
 * - scroll: no wrap, fixed size; swipe horizontally
 */
type LayoutMode = 'wrap' | 'fit' | 'scroll'
const LAYOUT_ORDER: LayoutMode[] = ['wrap', 'fit', 'scroll']
const LAYOUT_LABELS: Record<LayoutMode, string> = {
  wrap: '↩ wrap',
  fit: '⤢ fit',
  scroll: '↔ scroll',
}
const LAYOUT_TITLES: Record<LayoutMode, string> = {
  wrap: 'Lines wrap at spaces; wrapped continuations are indented. TUI borders may break',
  fit: 'No wrapping — text shrinks so full lines fit the screen width',
  scroll: 'Fixed size, no wrapping — swipe horizontally',
}

/** Monospace advance width as a fraction of font size (SF Mono/Menlo ≈ 0.6). */
const CHAR_W_RATIO = 0.6
/** Fit never shrinks below this; wider content falls back to horizontal scroll. */
const MIN_FIT_PX = 6
/** Horizontal padding of the output box (p-3 = 12px each side). */
const BOX_PAD_PX = 24

function loadLayout(): LayoutMode {
  const stored = loadPref<string>('wrapMode', '')
  if (LAYOUT_ORDER.includes(stored as LayoutMode)) return stored as LayoutMode
  // Legacy boolean pref: wrap-off becomes scroll; wrap-on is the default.
  return loadPref<boolean | null>('wrap', null) === false ? 'scroll' : 'wrap'
}

/** CSI, OSC (incl. OSC 8 hyperlinks) and Fe escapes — for column counting. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/**
 * Full-screen captures pad the bottom with blank lines and lines with trailing
 * spaces. Strip both: blank padding wastes portrait vertical space, trailing
 * spaces add phantom horizontal scroll. Also reports the widest used column
 * (ANSI stripped) so fit mode can size the font.
 */
function normalizeSnapshot(text: string): { text: string; maxCols: number } {
  const trimmed = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '')
  let maxCols = 0
  for (const line of trimmed.split('\n')) {
    const cols = line.replace(ANSI_RE, '').length
    if (cols > maxCols) maxCols = cols
  }
  return { text: trimmed, maxCols }
}

/**
 * Wrap each terminal line in a div so soft-wrapped continuations hang behind
 * the line start (CSS .tl), making them distinguishable from new terminal
 * lines. Spans/links left open at a newline are closed and reopened so colors
 * and OSC-8 links survive the split.
 */
function splitIntoLines(html: string): string {
  const tagRe = /<(\/?)(span|a)\b[^>]*>/g
  const open: { open: string; close: string }[] = []
  const out: string[] = []
  for (const raw of html.split('\n')) {
    const reopen = open.map((t) => t.open).join('')
    tagRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(raw)) !== null) {
      if (m[1] === '/') open.pop()
      else open.push({ open: m[0], close: `</${m[2]}>` })
    }
    const closers = open.map((t) => t.close).reverse().join('')
    out.push(`<div class="tl">${reopen}${raw}${closers}</div>`)
  }
  return out.join('')
}

/**
 * Reader pane for an agent's terminal screen snapshot. The response is a full
 * screen: content is replaced wholesale each poll, and identical text skips the
 * DOM update so text selection survives. Captured padding (trailing blank
 * lines, trailing spaces) is stripped before rendering. Three line layouts —
 * wrap (soft-wrapped continuations hang behind the line start), fit (font
 * shrinks so full lines fit the screen width, keeping TUI alignment), scroll
 * — cycled from the toolbar. This is a live snapshot, not a conversation log.
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
  const [layout, setLayout] = useState<LayoutMode>(loadLayout)
  const [textSize, setTextSize] = useState<TextSize>(loadTextSize)
  const [fitPx, setFitPx] = useState(0)
  const [showJump, setShowJump] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastTextRef = useRef('')
  const maxColsRef = useRef(0)
  const inFlightRef = useRef(false)

  const agentId = agent?.id ?? null

  useEffect(() => {
    lastTextRef.current = ''
    maxColsRef.current = 0
    setFitPx(0)
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
          const snap = normalizeSnapshot(res.text)
          // Identical screen (ignoring padding churn): skip to preserve selection.
          if (snap.text === lastTextRef.current) return
          lastTextRef.current = snap.text
          maxColsRef.current = snap.maxCols
          setHtml(splitIntoLines(ansi.ansi_to_html(snap.text)))
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

  // Fit mode: shrink the font until the widest used column fits the box.
  // Below MIN_FIT_PX the clamp kicks in and the box scrolls horizontally.
  useEffect(() => {
    const el = boxRef.current
    if (!el || layout !== 'fit') return
    const compute = () => {
      const cols = maxColsRef.current
      const avail = el.clientWidth - BOX_PAD_PX
      setFitPx(cols > 0 && avail > 0 ? Math.max(MIN_FIT_PX, Math.floor(avail / (cols * CHAR_W_RATIO))) : 0)
    }
    compute()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [html, layout])

  // Follow the bottom only when the user hasn't scrolled away.
  useEffect(() => {
    const el = boxRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [html, fitPx])

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

  const cycleLayout = () => {
    setLayout((m) => {
      const next = LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(m) + 1) % LAYOUT_ORDER.length]!
      savePref('wrapMode', next)
      return next
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

  const userPx = TEXT_SIZES[textSize]
  const fontPx = layout === 'fit' && fitPx > 0 ? Math.min(userPx, fitPx) : userPx

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
          onClick={cycleLayout}
          aria-label={`Line layout: ${layout} — tap for ${LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(layout) + 1) % LAYOUT_ORDER.length]}`}
          title={LAYOUT_TITLES[layout]}
          className="min-h-0 rounded-md px-2 py-1 text-xs text-fg-muted"
        >
          {LAYOUT_LABELS[layout]}
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
        className={`terminal-output min-h-0 min-w-0 flex-1 overflow-auto p-3 ${layout === 'wrap' ? '' : 'no-wrap'}`}
        style={{ fontSize: fontPx }}
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
