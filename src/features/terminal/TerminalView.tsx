import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalClientMessage, TerminalServerMessage } from '@shared/types'
import type { XtermPalette } from '../../lib/themes'
import { terminalWsUrl } from '../../lib/api'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import '@xterm/xterm/css/xterm.css'

export interface TerminalViewProps {
  agentId: string
  agentLabel: string
  theme: XtermPalette
  onClose: () => void
}

const FIT_THROTTLE_MS = 250
const FONT_SIZE = 12
const FONT_FAMILY = "ui-monospace, 'SF Mono', Menlo, monospace"

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

/** xterm's ITheme takes named colors, not an ordered array. */
function toITheme(p: XtermPalette): ITheme {
  const t: Record<string, string> = {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor,
    selectionBackground: p.selectionBackground,
  }
  p.ansi.slice(0, ANSI_NAMES.length).forEach((c, i) => {
    t[ANSI_NAMES[i]!] = c
  })
  return t as ITheme
}

/** Measure the real cell metrics of the terminal font (canvas measurement,
 *  the same mechanism xterm uses; no private APIs, no font-size guessing). */
function measureCell(): { w: number; h: number } {
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return { w: 7, h: 17 }
    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`
    const w = ctx.measureText('W').width
    const metrics = ctx.measureText('M')
    const h =
      metrics.fontBoundingBoxAscent !== undefined
        ? metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent
        : FONT_SIZE * 1.35
    return { w: Math.max(1, Math.ceil(w)), h: Math.max(1, Math.ceil(h)) }
  } catch {
    // jsdom and other canvas-less environments
    return { w: 7, h: 17 }
  }
}

/**
 * Interactive terminal: one WebSocket, owned grouped tmux session. The grid
 * reported by the server is preserved — if it is wider than the phone, the
 * wrapper scrolls horizontally instead of reflowing or clipping cells.
 * Rotation, keyboard open/close, and container changes NEVER resize the PTY.
 * The only resize path is the explicit, confirmed "Resize shared terminal to
 * fit" action, and dimensions are treated as confirmed only after the
 * server's `resized` acknowledgment.
 */
export function TerminalView({ agentId, agentLabel, theme, onClose }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const lastFitRef = useRef(0)

  const [status, setStatus] = useState<'connecting' | 'attached' | 'detached'>('connecting')
  const [detachReason, setDetachReason] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null)
  const [fitApplied, setFitApplied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resizeError, setResizeError] = useState<string | null>(null)
  const [cell] = useState(measureCell)

  // Live theme switching: xterm applies palette changes without remount.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = toITheme(theme)
  }, [theme])

  const cleanupSocket = useCallback(() => {
    const ws = wsRef.current
    wsRef.current = null
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'detach' } satisfies TerminalClientMessage))
      } catch {
        /* socket already failing */
      }
    }
    ws.close()
  }, [])

  const teardown = useCallback(() => {
    cleanupSocket()
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }, [cleanupSocket])

  const connect = useCallback(() => {
    const term = termRef.current
    if (!term) return
    setStatus('connecting')
    setDetachReason(null)
    setServerError(null)
    setResizeError(null)

    const ws = new WebSocket(terminalWsUrl())
    wsRef.current = ws
    ws.onopen = () => {
      if (wsRef.current !== ws) return
      // cols/rows are only a hint; the server attaches at the pane's real size.
      ws.send(JSON.stringify({ type: 'attach', agentId, cols: term.cols, rows: term.rows } satisfies TerminalClientMessage))
    }
    ws.onmessage = (ev: MessageEvent<string>) => {
      if (wsRef.current !== ws) return
      let msg: TerminalServerMessage
      try {
        msg = JSON.parse(ev.data) as TerminalServerMessage
      } catch {
        return
      }
      switch (msg.type) {
        case 'attached':
          setStatus('attached')
          term.resize(msg.cols, msg.rows)
          setGrid({ cols: msg.cols, rows: msg.rows })
          setFitApplied(false)
          break
        case 'output':
          term.write(msg.data)
          break
        case 'resized':
          // Authoritative only once acknowledged by the server.
          term.resize(msg.cols, msg.rows)
          setGrid({ cols: msg.cols, rows: msg.rows })
          setFitApplied(true)
          setResizeError(null)
          break
        case 'detached':
          setStatus('detached')
          setDetachReason(msg.reason)
          break
        case 'error':
          setServerError(msg.error)
          break
      }
    }
    ws.onclose = () => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      setStatus((s) => {
        if (s !== 'detached') setDetachReason('connection closed')
        return 'detached'
      })
    }
    ws.onerror = () => {
      if (wsRef.current !== ws) return
      setServerError('terminal websocket error')
    }
  }, [agentId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // No fit() on entry: the server-reported grid is preserved and the
    // wrapper scrolls horizontally when it exceeds the viewport.
    const term = new Terminal({
      disableStdin: false,
      convertEol: false,
      theme: toITheme(themeRef.current),
      fontSize: FONT_SIZE,
      fontFamily: FONT_FAMILY,
      scrollback: 2000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data } satisfies TerminalClientMessage))
      }
    })

    connect()

    return () => {
      dataSub.dispose()
      teardown()
      termRef.current = null
      fitRef.current = null
    }
    // agentId changes remount via key in App; connect() is stable per agentId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  function requestResize(): void {
    const fit = fitRef.current
    const ws = wsRef.current
    if (!fit || !ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (now - lastFitRef.current < FIT_THROTTLE_MS) return
    lastFitRef.current = now
    // Measure only — the live grid stays untouched until the user confirms.
    const proposal = fit.proposeDimensions()
    if (!proposal || proposal.cols < 1 || proposal.rows < 1) {
      setResizeError('cannot measure available space right now')
      return
    }
    setConfirmOpen(true)
  }

  function confirmResize(): void {
    const term = termRef.current
    const fit = fitRef.current
    const ws = wsRef.current
    setConfirmOpen(false)
    if (!term || !fit || !ws || ws.readyState !== WebSocket.OPEN) return
    const proposal = fit.proposeDimensions()
    if (!proposal || proposal.cols < 1 || proposal.rows < 1) {
      setResizeError('cannot measure available space right now')
      return
    }
    fit.fit()
    ws.send(JSON.stringify({ type: 'fit', cols: proposal.cols, rows: proposal.rows } satisfies TerminalClientMessage))
    // fitApplied flips only when the server acks with `resized`.
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2 safe-top">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-fg-muted" title={agentLabel}>
            {agentLabel}
            {grid ? (
              <span className="text-fg-muted/60">
                {' '}· {grid.cols}×{grid.rows} {fitApplied ? '· resized to fit' : '· server size'}
              </span>
            ) : null}
          </span>
          <button
            onClick={requestResize}
            disabled={status !== 'attached'}
            className="shrink-0 rounded-lg border border-warn/40 px-3 py-2 text-sm text-warn disabled:opacity-45"
          >
            Resize shared terminal…
          </button>
          <button
            onClick={onClose}
            aria-label="Return to Reader"
            className="shrink-0 rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-[11px] text-warn/90">
          Resize changes the shared tmux window layout for all clients. Rotation and keyboard
          never resize it.
        </p>
      </div>

      {status === 'connecting' && (
        <div className="shrink-0 bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">connecting…</div>
      )}
      {serverError && (
        <div className="shrink-0 bg-err/10 px-3 py-1.5 text-xs text-err">{serverError}</div>
      )}
      {resizeError && (
        <div role="status" className="shrink-0 bg-warn/10 px-3 py-1.5 text-xs text-warn">{resizeError}</div>
      )}
      {status === 'detached' && (
        <div className="flex shrink-0 items-center justify-between gap-2 bg-warn/10 px-3 py-2 text-xs text-warn">
          <span>detached: {detachReason ?? 'unknown reason'}</span>
          <span className="flex shrink-0 gap-2">
            <button
              onClick={connect}
              className="rounded-md border border-warn/40 px-3 py-1.5 text-warn hover:bg-warn/20"
            >
              Reconnect
            </button>
            <button
              onClick={onClose}
              className="rounded-md border border-line px-3 py-1.5 text-fg-muted"
            >
              Return to Reader
            </button>
          </span>
        </div>
      )}

      {/* Horizontal scroll preserves the server grid; xterm owns vertical
          scrollback internally. data-terminal-root: App key handler skips. */}
      <div data-terminal-root className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-bg p-1">
        <div
          className="h-full"
          style={{ width: grid ? grid.cols * cell.w + 8 : '100%', minWidth: '100%' }}
        >
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Resize shared terminal"
          targetLabel={agentLabel}
          warnings={[
            'This resizes the tmux window for every client attached to it, including the desktop.',
            'TUI apps will redraw at the new size; layout on other machines changes too.',
          ]}
          confirmLabel="Resize for all clients"
          requireAck
          onConfirm={confirmResize}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
