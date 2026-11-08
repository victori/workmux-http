import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { AgentView, KeyName } from '@shared/types'
import type { ConnectionState } from '../../hooks/useDashboard'
import { api, ApiError } from '../../lib/api'
import { copyText, loadTab, saveTab } from '../../lib/storage'
import { useVisualViewport } from '../../hooks/useVisualViewport'

const PLAIN_KEYS: { key: KeyName; label: string; aria: string }[] = [
  { key: 'enter', label: '⏎ Enter', aria: 'Send Enter key' },
  { key: 'esc', label: 'Esc', aria: 'Send Escape key' },
  { key: 'tab', label: 'Tab', aria: 'Send Tab key' },
  { key: 'left', label: '←', aria: 'Send left arrow' },
  { key: 'up', label: '↑', aria: 'Send up arrow' },
  { key: 'down', label: '↓', aria: 'Send down arrow' },
  { key: 'right', label: '→', aria: 'Send right arrow' },
]

const CTRL_LETTERS: { key: KeyName; label: string }[] = [
  { key: 'ctrl-c', label: 'C' },
  { key: 'ctrl-d', label: 'D' },
  { key: 'ctrl-u', label: 'U' },
  { key: 'ctrl-a', label: 'A' },
  { key: 'ctrl-e', label: 'E' },
  { key: 'ctrl-l', label: 'L' },
  { key: 'ctrl-r', label: 'R' },
]

type Notice = { kind: 'uncertain' | 'ended' | 'error'; text: string }

export interface ComposerProps {
  agent: AgentView | null
  connection: ConnectionState
  /** Latest raw output text, for the copy-output fallback. */
  outputRef?: MutableRefObject<string>
}

/**
 * Message + key composer. Enter inserts newlines; sending is explicit.
 * Drafts are per-target (in-memory + sessionStorage) and never auto-submitted.
 */
export function Composer({ agent, connection, outputRef }: ComposerProps) {
  const disabled = connection === 'offline' || connection === 'connecting'
  const vp = useVisualViewport()

  const draftsRef = useRef(new Map<string, string>())
  const prevIdRef = useRef<string | null>(agent?.id ?? null)
  const textRef = useRef('')

  const [text, setText] = useState<string>(() => {
    const id = agent?.id
    return id ? loadTab<string>(`draft:${id}`, '') : ''
  })
  textRef.current = text

  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  // Save the outgoing target's draft, restore the incoming one on switch.
  useEffect(() => {
    const prev = prevIdRef.current
    const next = agent?.id ?? null
    if (prev === next) return
    if (prev) draftsRef.current.set(prev, textRef.current)
    prevIdRef.current = next
    setCtrlArmed(false)
    setNotice(null)
    const draft = next ? draftsRef.current.get(next) ?? loadTab<string>(`draft:${next}`, '') : ''
    textRef.current = draft
    setText(draft)
  }, [agent?.id])

  function update(v: string): void {
    textRef.current = v
    setText(v)
    const id = agent?.id
    if (id) {
      draftsRef.current.set(id, v)
      saveTab(`draft:${id}`, v)
    }
  }

  function clearDraft(targetId: string): void {
    draftsRef.current.delete(targetId)
    saveTab(`draft:${targetId}`, '')
    if (prevIdRef.current === targetId) {
      textRef.current = ''
      setText('')
    }
  }

  function onApiError(err: unknown): void {
    if (err instanceof ApiError && err.status === 410) setNotice({ kind: 'ended', text: 'target ended — this agent is gone' })
    else if (err instanceof ApiError && err.status === 502) setNotice({ kind: 'uncertain', text: 'delivery uncertain — check the agent' })
    else setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'send failed' })
  }

  /** Target id is frozen at submission time, before any await. */
  function send(): void {
    if (!agent || disabled || sending) return
    const trimmed = textRef.current.trim()
    if (!trimmed) return
    const targetId = agent.id
    const requestId = crypto.randomUUID()
    setSending(true)
    setNotice(null)
    api
      .message(targetId, trimmed, requestId)
      .then((res) => {
        if (res.delivered === 'unknown') {
          // Keep the draft so the user can resend manually; never auto-retry.
          setNotice({ kind: 'uncertain', text: 'delivery uncertain — check the agent' })
        } else {
          clearDraft(targetId)
        }
      })
      .catch(onApiError)
      .finally(() => setSending(false))
  }

  function sendKey(key: KeyName): void {
    if (!agent || disabled || sending) return
    const targetId = agent.id
    const requestId = crypto.randomUUID()
    setNotice(null)
    api.keys(targetId, [key], requestId).catch(onApiError)
    setCtrlArmed(false)
  }

  async function copyOutput(): Promise<void> {
    const ok = await copyText(outputRef?.current ?? '')
    setCopied(ok ? 'Copied' : 'Copy failed')
    window.setTimeout(() => setCopied(null), 1500)
  }

  const keyboardPx = Math.max(0, window.innerHeight - vp.visibleHeight - vp.offsetTop)
  const keyBtn =
    'min-h-0 shrink-0 rounded-md border border-line px-2 py-1.5 text-xs font-medium text-fg-muted'

  return (
    <div
      className="shrink-0 border-t border-line bg-surface px-2 pt-2"
      style={{ paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + ${keyboardPx}px)` }}
    >
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-2 rounded-lg px-3 py-2 text-xs font-medium ${
            notice.kind === 'uncertain'
              ? 'bg-warn/15 text-warn'
              : 'bg-err/15 text-err'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-1">
        {PLAIN_KEYS.map((k) => (
          <button
            key={k.key}
            onClick={() => sendKey(k.key)}
            disabled={disabled || sending || !agent}
            aria-label={k.aria}
            className={keyBtn}
          >
            {k.label}
          </button>
        ))}
        <button
          onClick={() => setCtrlArmed((a) => !a)}
          disabled={disabled || sending || !agent}
          aria-pressed={ctrlArmed}
          aria-label="Arm Ctrl one-shot"
          className={`${keyBtn} ${ctrlArmed ? 'border-accent bg-accent/15 text-accent' : ''}`}
        >
          ⌃ Ctrl{ctrlArmed ? ' ·' : ''}
        </button>
        <button onClick={() => void copyOutput()} className={`${keyBtn} ml-auto`} aria-label="Copy output">
          {copied ?? 'Copy output'}
        </button>
      </div>

      {ctrlArmed && (
        <div className="mb-2 flex items-center gap-1" role="group" aria-label="Ctrl combos">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">Ctrl +</span>
          {CTRL_LETTERS.map((c) => (
            <button
              key={c.key}
              onClick={() => sendKey(c.key)}
              disabled={disabled || sending}
              aria-label={`Send Ctrl-${c.label.toLowerCase()}`}
              className={`${keyBtn} border-accent/50 text-accent`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => update(e.target.value)}
          rows={2}
          aria-label="Message"
          placeholder={agent ? 'Message agent… (Enter = newline)' : 'No agent selected'}
          disabled={disabled || !agent}
          className="min-h-[44px] flex-1 resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-base text-fg placeholder:text-fg-muted/60 disabled:opacity-45 md:text-sm"
        />
        <button
          onClick={send}
          disabled={disabled || sending || !agent || text.trim() === ''}
          className="shrink-0 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-bg disabled:opacity-45"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {connection === 'offline' && (
        <p className="mt-1 text-[11px] text-err">Disconnected — sending disabled.</p>
      )}
    </div>
  )
}
