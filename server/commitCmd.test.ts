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

  it('should keep $@ as a literal token', () => {
    expect(tokenizeCommand('git commit -m "$@"')).toEqual(['git', 'commit', '-m', '$@'])
  })
})

describe('buildCommitArgv', () => {
  it('should append the message when no $@ is present', () => {
    expect(buildCommitArgv('opencode-commit -a', 'feat: x')).toEqual([
      'opencode-commit',
      '-a',
      'feat: x',
    ])
  })

  it('should substitute $@ at its position', () => {
    expect(buildCommitArgv('git commit -m $@ --quiet', 'the msg')).toEqual([
      'git',
      'commit',
      '-m',
      'the msg',
      '--quiet',
    ])
  })

  it('should substitute quoted "$@" identically', () => {
    expect(buildCommitArgv('my-commit --sign -- "$@"', 'a b  c')).toEqual([
      'my-commit',
      '--sign',
      '--',
      'a b  c',
    ])
  })

  it('should pass the message through as one inert element', () => {
    const msg = "'; rm -rf /`x` $(y) && z"
    const argv = buildCommitArgv('tool $@', msg)
    expect(argv).toEqual(['tool', msg])
  })

  it('should drop $@ and append nothing for an empty message', () => {
    expect(buildCommitArgv('git commit -m $@ -S', '   ')).toEqual(['git', 'commit', '-m', '-S'])
    expect(buildCommitArgv('git commit', '')).toEqual(['git', 'commit'])
    expect(buildCommitArgv(`git commit -m "$@"`, '  \n ')).toEqual(['git', 'commit', '-m'])
  })

  it('should reject an empty command', () => {
    expect(() => buildCommitArgv('   ', 'msg')).toThrow('commit command is empty')
  })
})
