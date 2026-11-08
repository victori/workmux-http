/**
 * Build the argv for the configurable commit command. Config strings are
 * tokenized on whitespace with single/double quote grouping; `$@` is replaced
 * by the commit message as ONE argv element (appended when absent). There is
 * no shell, no expansion, no escape processing — the message can never be
 * re-interpreted.
 */

const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g

export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = []
  for (let m = TOKEN_RE.exec(cmd); m !== null; m = TOKEN_RE.exec(cmd)) {
    tokens.push(m[1] ?? m[2] ?? m[3]!)
  }
  return tokens
}

export function buildCommitArgv(cmd: string, message: string): string[] {
  const tokens = tokenizeCommand(cmd)
  if (tokens.length === 0) throw new Error('commit command is empty')
  const msg = message.trim()
  const at = tokens.indexOf('$@')
  if (at >= 0) {
    return msg
      ? [...tokens.slice(0, at), msg, ...tokens.slice(at + 1)]
      : [...tokens.slice(0, at), ...tokens.slice(at + 1)]
  }
  return msg ? [...tokens, msg] : tokens
}
