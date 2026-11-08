import { useEffect, useState } from 'react'

export interface ViewportInfo {
  /** Height in CSS px available above the software keyboard. */
  visibleHeight: number
  /** Offset of the visual viewport from layout top (keyboard/scroll). */
  offsetTop: number
}

/**
 * Tracks the visual viewport so the composer stays above the iOS software
 * keyboard. Layout recalculates on keyboard, viewport, and orientation changes;
 * the underlying agent pane is never resized by this.
 */
export function useVisualViewport(): ViewportInfo {
  const [info, setInfo] = useState<ViewportInfo>({
    visibleHeight: window.innerHeight,
    offsetTop: 0,
  })

  useEffect(() => {
    const vv = window.visualViewport
    const update = () => {
      setInfo({
        visibleHeight: vv ? vv.height : window.innerHeight,
        offsetTop: vv ? vv.offsetTop : 0,
      })
    }
    update()
    if (!vv) {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('orientationchange', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  return info
}
