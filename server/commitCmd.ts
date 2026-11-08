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
 *     for their quoting context (backslash-aware scan honoring POSIX rules:
 *     escapes work outside and inside `"…"` never inside `'…'`) so a hostile
 *     message stays inert when the shell re-parses — double-quote regions
 *     backslash-escape `\ " $ \``; single-quote regions split-and-requote;
 *     bare occurrences get POSIX single-quote wrapping.
 *  3. SUBSTRING for non-shell commands: raw replacement (no shell sits
 *     between us and the command).
 *
 * No placeholder anywhere → the message is appended as the last argv
 * element (nothing appended when empty). No eval, ever.
 */

// Double-quoted spans keep escaped quotes (`\"`) inside the token instead of
// terminating it; single quotes end at the next `'` (POSIX: nothing escapes
// inside single quotes).
const TOKEN_RE = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g

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

/**
 * Substitute placeholder occurrences within one token's text using a
 * left-to-right quote-context scan with POSIX backslash rules: `\` escapes
 * the next char outside and inside double quotes, and NOTHING escapes inside
 * single quotes. Regex pair-matching (`"([^"]*)"`) misreads `\"` as a
 * closing quote and would classify the placeholder in the wrong context,
 * letting `$(…)` in a message execute when the shell re-parses (audit F02).
 */
function substituteIn(text: string, placeholder: string, msg: string, shell: boolean): string {
  if (!shell) return replaceAllLiteral(text, placeholder, msg)

  let out = ''
  let i = 0
  let ctx: 'bare' | 'dquote' | 'squote' = 'bare'
  while (i < text.length) {
    if (text.startsWith(placeholder, i)) {
      if (ctx === 'dquote') out += escapeDoubleQuoted(msg)
      // Inside a single-quoted region the message is inert verbatim unless it
      // contains a quote; only then close, insert a quoted copy, reopen.
      else if (ctx === 'squote') out += msg.includes("'") ? `'${shellQuote(msg)}'` : msg
      else out += shellQuote(msg)
      i += placeholder.length
      continue
    }
    const c = text[i]!
    if (ctx === 'bare') {
      if (c === '\\' && i + 1 < text.length) {
        out += c + text[i + 1]!
        i += 2
        continue
      }
      if (c === '"') ctx = 'dquote'
      else if (c === "'") ctx = 'squote'
      out += c
      i++
      continue
    }
    if (ctx === 'dquote') {
      if (c === '\\' && i + 1 < text.length) {
        out += c + text[i + 1]!
        i += 2
        continue
      }
      if (c === '"') ctx = 'bare'
      out += c
      i++
      continue
    }
    // squote: nothing escapes; the next ' ends the region.
    if (c === "'") ctx = 'bare'
    out += c
    i++
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
