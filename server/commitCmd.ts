/**
 * Build the argv for the configurable commit command. Config strings are
 * tokenized on whitespace with single/double quote grouping; the outer
 * grouping quotes are consumed here (they are config syntax, not content).
 *
 * `{{COMMIT_MSG}}` substitution:
 *  1. WHOLE-TOKEN (`… {{COMMIT_MSG}} …`): the message becomes ONE argv
 *     element (dropped when empty). The message never enters any re-parsed
 *     string — safest form; use `_ {{COMMIT_MSG}}` + inner `"$@"` for
 *     shell wrappers.
 *  2. SUBSTRING inside a SHELL wrapper command (sh/bash/zsh/dash/ksh,
 *     e.g. `zsh -ic 'tool -a "{{COMMIT_MSG}}"'`): occurrences are escaped
 *     for their quoting context so a hostile message stays inert when the
 *     shell re-parses — double-quote regions backslash-escape `\ " $ \``;
 *     single-quote regions split-and-requote; bare occurrences get POSIX
 *     single-quote wrapping.
 *  3. SUBSTRING for non-shell commands: raw replacement (no shell sits
 *     between us and the command).
 *
 * No placeholder anywhere → the message is appended as the last argv
 * element (nothing appended when empty). No eval, ever.
 */

const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g

export const COMMIT_MSG_PLACEHOLDER = '{{COMMIT_MSG}}'

const SHELL_BASENAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** Escape so text stays inert INSIDE a double-quoted shell region. */
function escapeDoubleQuoted(s: string): string {
  return s.replace(/(["$\\`])/g, '\\$1')
}

/** POSIX single-quote wrapping: safe against every metacharacter. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function replaceAllLiteral(haystack: string, value: string): string {
  return haystack.split(COMMIT_MSG_PLACEHOLDER).join(value)
}

/** Substitute placeholder occurrences within one token's text. */
function substituteIn(text: string, msg: string, shell: boolean): string {
  if (!shell) return replaceAllLiteral(text, msg)

  // Double-quoted regions inside the text: escape for "…" context.
  let out = text.replace(/"([^"]*)"/g, (_m, inner: string) =>
    inner.includes(COMMIT_MSG_PLACEHOLDER)
      ? `"${replaceAllLiteral(inner, escapeDoubleQuoted(msg))}"`
      : `"${inner}"`,
  )
  // Single-quoted regions: 'pre{{X}}post' → 'pre'<quoted msg>'post'
  // (adjacent quoted words concatenate in the shell).
  out = out.replace(/'([^']*)'/g, (_m, inner: string) => {
    if (!inner.includes(COMMIT_MSG_PLACEHOLDER)) return `'${inner}'`
    const parts = inner.split(COMMIT_MSG_PLACEHOLDER)
    let r = parts[0] === '' ? '' : `'${parts[0]}'`
    for (const p of parts.slice(1)) {
      r += shellQuote(msg)
      if (p !== '') r += `'${p}'`
    }
    return r
  })
  // Remaining bare occurrences: single-quote wrap each insertion point.
  if (out.includes(COMMIT_MSG_PLACEHOLDER)) {
    const parts = out.split(COMMIT_MSG_PLACEHOLDER)
    out = parts[0]!
    for (const p of parts.slice(1)) out += `${shellQuote(msg)}${p}`
  }
  return out
}

interface Tok {
  text: string
}

function tokenizeDetailed(cmd: string): string[] {
  const toks: string[] = []
  for (let m = TOKEN_RE.exec(cmd); m !== null; m = TOKEN_RE.exec(cmd)) {
    toks.push(m[1] ?? m[2] ?? m[3]!)
  }
  return toks
}

export function tokenizeCommand(cmd: string): string[] {
  return tokenizeDetailed(cmd)
}

export function buildCommitArgv(cmd: string, message: string): string[] {
  const toks = tokenizeDetailed(cmd)
  if (toks.length === 0) throw new Error('commit command is empty')
  const msg = message.trim()
  const first = toks[0]!.split('/').pop() ?? ''
  const shell = SHELL_BASENAMES.has(first)

  let sawPlaceholder = false
  const out: string[] = []
  for (const t of toks) {
    if (t === COMMIT_MSG_PLACEHOLDER) {
      sawPlaceholder = true
      if (msg) out.push(msg)
      continue
    }
    if (t.includes(COMMIT_MSG_PLACEHOLDER)) {
      sawPlaceholder = true
      out.push(substituteIn(t, msg, shell))
      continue
    }
    out.push(t)
  }
  if (!sawPlaceholder && msg) out.push(msg)
  if (out.length === 0) throw new Error('commit command is empty')
  return out
}
