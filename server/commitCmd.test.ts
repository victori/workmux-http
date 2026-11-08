import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildCommitArgv, buildPushArgv, tokenizeCommand } from './commitCmd.js'

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

describe('buildPushArgv', () => {
  it('should substitute whole-token branch and remote as single argv elements', () => {
    expect(buildPushArgv('my-push {{BRANCH}} {{REMOTE}}', { branch: 'feat x', remote: 'origin' })).toEqual([
      'my-push',
      'feat x',
      'origin',
    ])
  })

  it('should substitute substring placeholders inside a zsh -c string', () => {
    const argv = buildPushArgv(`zsh -ic 'git push -u origin {{BRANCH}}'`, { branch: 'main', remote: 'origin' })
    expect(argv).toEqual(['zsh', '-ic', `git push -u origin 'main'`])
  })

  it('should escape hostile branch inside double-quoted shell region', () => {
    const argv = buildPushArgv(`zsh -ic 'git push origin "{{BRANCH}}"'`, {
      branch: 'm"$(id)`x`',
      remote: 'origin',
    })
    expect(argv).toHaveLength(3)
    expect(argv[2]).toBe('git push origin "m\\"\\$(id)\\`x\\`"')
  })

  it('should append branch when no placeholder is present', () => {
    expect(buildPushArgv('my-push', { branch: 'main', remote: 'origin' })).toEqual(['my-push', 'main'])
  })

  it('should throw on empty command', () => {
    expect(() => buildPushArgv('   ', { branch: 'main', remote: 'origin' })).toThrow(/empty/)
  })
})

describe('backslash-aware quoting contexts (audit F02)', () => {
  it('keeps command substitution inert after a backslash-escaped quote in a dq region', () => {
    const argv = buildCommitArgv(`sh -c 'printf "%s\\n" "prefix\\"{{COMMIT_MSG}}suffix"'`, '$(printf AUDIT_MARKER)')
    expect(argv).toHaveLength(3)
    expect(argv[2]).toContain('\\$(printf AUDIT_MARKER)')
  })

  it('round-trips a hostile message through a real shell without executing it', () => {
    const argv = buildCommitArgv(`sh -c 'printf "%s" "p\\"{{COMMIT_MSG}}s"'`, '$(id)`whoami`')
    const out = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    expect(out).toBe('p"$(id)`whoami`s')
  })

  it('round-trips a message through a single-quoted region (nothing escapes inside sq)', () => {
    const argv = buildCommitArgv(`sh -c 'printf %s "p{{COMMIT_MSG}}s"'`, `a$(id)b'c`)
    const out = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    expect(out).toBe(`pa$(id)b'cs`)
  })

  it('keeps escaped quotes inside double-quoted config tokens intact when tokenizing', () => {
    const toks = tokenizeCommand(`git commit -m "msg with \\"quoted\\" text"`)
    expect(toks).toEqual(['git', 'commit', '-m', 'msg with \\"quoted\\" text'])
  })
})
