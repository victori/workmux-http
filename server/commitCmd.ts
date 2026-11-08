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

function replaceAllLiteral(haystack: string, needle: string, value: string): string {
  return haystack.split(needle).join(value)
}

/** Substitute placeholder occurrences within one token's text. */
function substituteIn(text: string, placeholder: string, msg: string, shell: boolean): string {
  if (!shell) return replaceAllLiteral(text, placeholder, msg)

  // Double-quoted regions inside the text: escape for "…" context.
  let out = text.replace(/"([^"]*)"/g, (_m, inner: string) =>
    inner.includes(placeholder)
      ? `"${replaceAllLiteral(inner, placeholder, escapeDoubleQuoted(msg))}"`
      : `"${inner}"`,
  )
  // Single-quoted regions: 'pre{{X}}post' → 'pre'<quoted msg>'post'
  // (adjacent quoted words concatenate in the shell).
  out = out.replace(/'([^']*)'/g, (_m, inner: string) => {
    if (!inner.includes(placeholder)) return `'${inner}'`
    const parts = inner.split(placeholder)
    let r = parts[0] === '' ? '' : `'${parts[0]}'`
    for (const p of parts.slice(1)) {
      r += shellQuote(msg)
      if (p !== '') r += `'${p}'`
    }
    return r
  })
  // Remaining bare occurrences: single-quote wrap each insertion point.
  if (out.includes(placeholder)) {
    const parts = out.split(placeholder)
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
      out.push(substituteIn(t, COMMIT_MSG_PLACEHOLDER, msg, shell))
      continue
    }
    out.push(t)
  }
  if (!sawPlaceholder && msg) out.push(msg)
  if (out.length === 0) throw new Error('commit command is empty')
  return out
}

export const PUSH_BRANCH_PLACEHOLDER = '{{BRANCH}}'
export const PUSH_REMOTE_PLACEHOLDER = '{{REMOTE}}'

/**
 * Build argv for a configured push command. `{{BRANCH}}` / `{{REMOTE}}`
 * follow the same rules as `{{COMMIT_MSG}}`: whole-token → one argv
 * element; substring → context-aware escaping when the command starts
 * with a shell (e.g. `zsh -ic 'git push -u {{REMOTE}} {{BRANCH}}'`).
 * With no `{{BRANCH}}` token anywhere, the branch is appended as the last
 * argv element. The wrapper owns flags (e.g. `-u` for first push).
 */
export function buildPushArgv(cmd: string, vars: { branch: string; remote: string }): string[] {
  const toks = tokenizeDetailed(cmd)
  if (toks.length === 0) throw new Error('push command is empty')
  const first = toks[0]!.split('/').pop() ?? ''
  const shell = SHELL_BASENAMES.has(first)

  let sawBranch = false
  const out: string[] = []
  for (const t of toks) {
    let tok = t
    for (const [ph, value] of [
      [PUSH_BRANCH_PLACEHOLDER, vars.branch],
      [PUSH_REMOTE_PLACEHOLDER, vars.remote],
    ] as const) {
      if (!tok.includes(ph)) continue
      if (ph === PUSH_BRANCH_PLACEHOLDER) sawBranch = true
      tok = tok === ph ? value : substituteIn(tok, ph, value, shell)
    }
    out.push(tok)
  }
  if (!sawBranch) out.push(vars.branch)
  if (out.length === 0) throw new Error('push command is empty')
  return out
}
