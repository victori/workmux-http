import { execFile } from 'node:child_process'
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

/** Run argv directly (no shell), bounded by time and output size. */
export function run(
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  const [cmd, ...args] = argv
  if (!cmd) return Promise.reject(new Error('empty argv'))
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>()
  const child = execFile(
    cmd,
    args,
    {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? BOUNDS.subprocessTimeoutMs,
      maxBuffer: BOUNDS.maxSubprocessOutputBytes,
      killSignal: 'SIGKILL',
      env: process.env,
    },
    (err, stdout, stderr) => {
      if (err && runError(err).isSpawnFailure) {
        reject(runError(err))
        return
      }
      const truncated =
        stdout.length >= BOUNDS.maxSubprocessOutputBytes ||
        stderr.length >= BOUNDS.maxSubprocessOutputBytes
      const code = err ? (runError(err).code ?? (runError(err).killed ? 124 : 1)) : 0
      resolve({ code, stdout, stderr, truncated })
    },
  )
  if (opts.input !== undefined && child.stdin) {
    child.stdin.end(opts.input)
  }
  return promise
}
