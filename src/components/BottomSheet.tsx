import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * iPhone bottom sheet: backdrop + rounded-top panel sliding up. Closes on
 * backdrop tap and Esc; autofocuses the first interactive element.
 */
export function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    ;(bodyRef.current ?? panelRef.current)?.querySelector<HTMLElement>('input, button, select, textarea')?.focus()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div
        aria-hidden
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative z-10 max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border-t border-line bg-surface shadow-2xl transition-transform duration-200 ease-out safe-bottom ${
          shown ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface px-4 py-3">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-fg-muted">
            ✕
          </button>
        </div>
        <div ref={bodyRef} className="px-4 py-3">{children}</div>
      </div>
    </div>
  )
}
