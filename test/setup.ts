import '@testing-library/jest-dom/vitest'

// jsdom does not surface Web Storage on globalThis under this stack; provide
// in-memory fallbacks so storage-backed preferences work in component tests.
function installStorage(target: object, name: string): void {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  }
  Object.defineProperty(target, name, { value: storage, configurable: true, writable: true })
}

if (typeof globalThis.localStorage === 'undefined') installStorage(globalThis, 'localStorage')
if (typeof globalThis.sessionStorage === 'undefined') installStorage(globalThis, 'sessionStorage')
