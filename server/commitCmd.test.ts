import { describe, expect, it } from 'vitest'
import { buildCommitArgv, tokenizeCommand } from './commitCmd.js'

describe('tokenizeCommand', () => {
  it('should split on whitespace', () => {
    expect(tokenizeCommand('git  commit   -m')).toEqual(['git', 'commit', '-m'])
  })

  it('should group quoted segments and strip quotes', () => {
    expect(tokenizeCommand('my commit --msg "hello world"')).toEqual([
      'my',
      'commit',
      '--msg',
      'hello world',
    ])
    expect(tokenizeCommand("opencode-commit --opt 'a $b `c`'")).toEqual([
      'opencode-commit',
      '--opt',
      'a $b `c`',
    ])
  })

  it('should keep {{COMMIT_MSG}} as a literal token', () => {
    expect(tokenizeCommand('git commit -m "{{COMMIT_MSG}}"')).toEqual([
      'git',
      'commit',
      '-m',
      '{{COMMIT_MSG}}',
    ])
  })

  it('should keep $@ as an inert token (no special meaning)', () => {
    expect(buildCommitArgv('git commit -m $@', 'msg')).toEqual(['git', 'commit', '-m', '$@', 'msg'])
  })
})

describe('buildCommitArgv', () => {
  it('should append the message when no placeholder is present', () => {
    expect(buildCommitArgv('opencode-commit -a', 'feat: x')).toEqual([
      'opencode-commit',
      '-a',
      'feat: x',
    ])
  })

  it('should substitute {{COMMIT_MSG}} at its position', () => {
    expect(buildCommitArgv('git commit -m {{COMMIT_MSG}} --quiet', 'the msg')).toEqual([
      'git',
      'commit',
      '-m',
      'the msg',
      '--quiet',
    ])
  })

  it('should substitute quoted "{{COMMIT_MSG}}" identically', () => {
    expect(buildCommitArgv('my-commit --sign -- "{{COMMIT_MSG}}"', 'a b  c')).toEqual([
      'my-commit',
      '--sign',
      '--',
      'a b  c',
    ])
  })

  it('should substitute the trailing placeholder used by zsh wrappers', () => {
    expect(
      buildCommitArgv(`zsh -ic 'opencode-commit -a "$@"' _ {{COMMIT_MSG}}`, 'feat: y'),
    ).toEqual(['zsh', '-ic', 'opencode-commit -a "$@"', '_', 'feat: y'])
  })

  it('should pass the message through as one inert element', () => {
    const msg = "'; rm -rf /`x` $(y) && z"
    const argv = buildCommitArgv('tool {{COMMIT_MSG}}', msg)
    expect(argv).toEqual(['tool', msg])
  })

  it('should drop the placeholder and append nothing for an empty message', () => {
    expect(buildCommitArgv('git commit -m {{COMMIT_MSG}} -S', '   ')).toEqual([
      'git',
      'commit',
      '-m',
      '-S',
    ])
    expect(buildCommitArgv('git commit', '')).toEqual(['git', 'commit'])
    expect(buildCommitArgv(`git commit -m "{{COMMIT_MSG}}"`, '  \n ')).toEqual(['git', 'commit', '-m'])
    expect(
      buildCommitArgv(`zsh -ic 'opencode-commit -a "$@"' _ {{COMMIT_MSG}}`, ''),
    ).toEqual(['zsh', '-ic', 'opencode-commit -a "$@"', '_'])
  })

  it('should reject an empty command', () => {
    expect(() => buildCommitArgv('   ', 'msg')).toThrow('commit command is empty')
  })

  it('should substitute substrings in shell wrappers with dq escaping', () => {
    expect(
      buildCommitArgv(`zsh -ic 'opencode-commit -a "{{COMMIT_MSG}}"'`, 'feat: x'),
    ).toEqual(['zsh', '-ic', 'opencode-commit -a "feat: x"'])
  })

  it('should keep hostile messages inert in dq regions', () => {
    const msg = 'x"; touch /tmp/pwn; echo `' + '` and $(id)'
    const argv = buildCommitArgv(`zsh -ic 'printf %s "{{COMMIT_MSG}}" > out.txt'`, msg)
    expect(argv[2]).toContain('\\"')
    expect(argv[2]).toContain('\\`')
    expect(argv[2]).toContain('\\$')
  })

  it('should single-quote-wrap bare occurrences in shell wrappers', () => {
    expect(buildCommitArgv(`zsh -ic 'tool -a {{COMMIT_MSG}}'`, "it's here")).toEqual([
      'zsh',
      '-ic',
      `tool -a 'it'\\''s here'`,
    ])
  })

  it('should split-and-requote single-quote regions in shell wrappers', () => {
    const argv = buildCommitArgv(`zsh -c "echo '{{COMMIT_MSG}}'"`, 'a b')
    expect(argv).toEqual(['zsh', '-c', `echo 'a b'`])
  })

  it('should leave ! unescaped in dq (zsh/bash -c never history-expands)', () => {
    // Escaping `!` with a backslash would CORRUPT content (backslash is
    // literal inside zsh double quotes); verified live that `zsh -ic` does
    // not history-expand the -c string: 'boom !! ls' arrived byte-identical.
    expect(buildCommitArgv(`zsh -ic 'printf %s "{{COMMIT_MSG}}" > f'`, 'boom !! ls')).toEqual([
      'zsh',
      '-ic',
      'printf %s "boom !! ls" > f',
    ])
  })

  it('should replace raw substrings for non-shell commands', () => {
    expect(buildCommitArgv('git commit -m{{COMMIT_MSG}}', 'a b')).toEqual([
      'git',
      'commit',
      '-ma b',
    ])
  })

  it('should leave an empty dq placeholder for empty messages in wrappers', () => {
    expect(buildCommitArgv(`zsh -ic 'opencode-commit -a "{{COMMIT_MSG}}"'`, '  ')).toEqual([
      'zsh',
      '-ic',
      'opencode-commit -a ""',
    ])
  })
})
