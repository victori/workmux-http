const PREFIX = 'wmhttp:'

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function savePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // private mode / quota: preferences are best-effort
  }
}

const SESSION_PREFIX = 'wmhttp-tab:'

export function loadTab<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function saveTab<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(SESSION_PREFIX + key, JSON.stringify(value))
  } catch {
    // tab memory is best-effort
  }
}

/** Clipboard with HTTP fallback for non-secure contexts (Safari over VPN HTTP). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
