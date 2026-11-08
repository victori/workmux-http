import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalServerMessage } from '@shared/types'
import { terminalWsUrl } from '../../lib/api'

export interface TerminalViewProps {
  agentId: string
  agentLabel: string
  onClose: () => void
}

const THEME = {
  background: '#0b0f14',
  foreground: '#dce3ea',
  cursor: '#4cc2ff',
  selectionBackground: '#263241',
}

const FIT_THROTTLE_MS = 250

export function TerminalView({ agentId, agentLabel, onClose }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastFitRef = useRef(0)

  const [status, setStatus] = useState<'connecting' | 'attached' | 'detached'>('connecting')
  const [detachReason, setDetachReason] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [paneSize, setPaneSize] = useState<{ cols: number; rows: number } | null>(null)

  const cleanupSocket = useCallback(() => {
    const ws = wsRef.current
    wsRef.current = null
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'detach' }))
      } catch {
        /* socket already failing */
      }
      ws.close()
    } else {
      ws.close()
    }
  }, [])

  const teardown = useCallback(() => {
    cleanupSocket()
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
  }, [cleanupSocket])

  const connect = useCallback(() => {
    const container = containerRef.current
    const term = termRef.current
    if (!container || !term) return
    setStatus('connecting')
    setDetachReason(null)
    setServerError(null)
    setPaneSize(null)

    const ws = new WebSocket(terminalWsUrl())
    wsRef.current = ws
    ws.onopen = () => {
      if (wsRef.current !== ws) return
      // cols/rows are only a request hint; the server keeps the pane's real size.
      ws.send(JSON.stringify({ type: 'attach', agentId, cols: term.cols, rows: term.rows }))
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
          // Server size is authoritative — resize the local echo to match.
          term.resize(msg.cols, msg.rows)
          setPaneSize({ cols: msg.cols, rows: msg.rows })
          break
        case 'output':
          term.write(msg.data)
          break
        case 'resized':
          term.resize(msg.cols, msg.rows)
          setPaneSize({ cols: msg.cols, rows: msg.rows })
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
    const term = new Terminal({
      disableStdin: false,
      convertEol: false,
      theme: THEME,
      fontSize: 12,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
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

  function fitToScreen(): void {
    const term = termRef.current
    const fit = fitRef.current
    const ws = wsRef.current
    if (!term || !fit || !ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (now - lastFitRef.current < FIT_THROTTLE_MS) return
    lastFitRef.current = now
    fit.fit()
    ws.send(JSON.stringify({ type: 'fit', cols: term.cols, rows: term.rows }))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-2 safe-top">
        <span className="min-w-0 flex-1 truncate text-sm text-fg-muted" title={agentLabel}>
          {agentLabel}
          {paneSize ? (
            <span className="text-fg-muted/60">
              {' '}· showing agent at {paneSize.cols}x{paneSize.rows} (original size)
            </span>
          ) : null}
        </span>
        <button
          onClick={fitToScreen}
          disabled={status !== 'attached'}
          aria-label="Fit to screen — resizes shared tmux window for all clients"
          title="resizes shared tmux window for all clients"
          className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm text-fg-muted hover:bg-surface-2"
        >
          Fit to screen
        </button>
        <button onClick={onClose} aria-label="Close terminal" className="shrink-0 rounded-lg px-3 py-2 text-sm text-fg-muted hover:bg-surface-2">
          ✕
        </button>
      </div>

      {status === 'connecting' && (
        <div className="shrink-0 bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">connecting…</div>
      )}
      {serverError && (
        <div className="shrink-0 bg-err/10 px-3 py-1.5 text-xs text-err">{serverError}</div>
      )}
      {status === 'detached' && (
        <div className="flex shrink-0 items-center justify-between gap-2 bg-warn/10 px-3 py-2 text-xs text-warn">
          <span>detached: {detachReason ?? 'unknown reason'}</span>
          <button
            onClick={connect}
            className="rounded-md border border-warn/40 px-3 py-1.5 text-warn hover:bg-warn/20"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* data-terminal-root: App's global key handler ignores keys inside here */}
      <div data-terminal-root className="min-h-0 flex-1 bg-bg p-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  )
}
