import { spawn } from 'node:child_process'
import { BOUNDS } from './config.js'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** True when output exceeded the bound and was cut. */
  truncated: boolean
}

export interface RunError extends Error {
  code: number | null
  killed: boolean
  isSpawnFailure: boolean
  stdout: string
  stderr: string
}

function runError(err: unknown): RunError {
  const e = (err ?? {}) as {
    message?: string
    killed?: boolean
    code?: unknown
    errno?: string
    stdout?: unknown
    stderr?: unknown
  }
  const wrapped = new Error(`${e.message ?? 'command failed'}`) as RunError
  wrapped.code = typeof e.code === 'number' ? e.code : e.errno === 'ENOENT' ? -2 : null
  wrapped.killed = e.killed === true
  wrapped.isSpawnFailure = e.errno === 'ENOENT' || e.code === 'ENOENT'
  wrapped.stdout = typeof e.stdout === 'string' ? e.stdout : ''
  wrapped.stderr = typeof e.stderr === 'string' ? e.stderr : ''
  return wrapped
}

/**
 * Run argv directly (no shell), bounded by time and output size.
 *
 * The child is spawned `detached` (new session/process group) so the
 * timeout kill `kill(-pid)` reaches the WHOLE tree: wrapper commands
 * (e.g. `zsh -ic '…'`) spawn grandchildren that would otherwise be
 * orphaned and keep running — a "failed" commit silently completing in
 * the background, or a grandchild holding our stdout pipe open past the
 * timeout.
 */
export function run(
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  const [cmd, ...args] = argv
  if (!cmd) return Promise.reject(new Error('empty argv'))
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>()
  const timeoutMs = opts.timeoutMs ?? BOUNDS.subprocessTimeoutMs
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })

  let out = ''
  let errOut = ''
  let truncated = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    out += d
    if (out.length >= BOUNDS.maxSubprocessOutputBytes) {
      out = out.slice(0, BOUNDS.maxSubprocessOutputBytes)
      truncated = true
    }
  })
  child.stderr.on('data', (d: string) => {
    errOut += d
    if (errOut.length >= BOUNDS.maxSubprocessOutputBytes) {
      errOut = errOut.slice(0, BOUNDS.maxSubprocessOutputBytes)
      truncated = true
    }
  })
  child.stdin?.on('error', () => {
    /* EPIPE when the child exits before consuming input */
  })

  let killed = false
  const timer = setTimeout(() => {
    killed = true
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already dead */
      }
    }
  }, timeoutMs)

  // Always deliver EOF on stdin: CLIs that opportunistically read piped
  // input (e.g. `opencode run`) otherwise block forever waiting for data
  // that never comes, looking like "the command was never invoked".
  child.stdin?.end(opts.input ?? '')

  child.on('error', (err) => {
    clearTimeout(timer)
    reject(runError(err))
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    resolve({
      code: code ?? (killed ? 124 : signal ? 1 : 0),
      stdout: out,
      stderr: errOut,
      truncated,
    })
  })
  return promise
}
