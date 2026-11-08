import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig commit settings', () => {
  it('should resolve the exact kind variable', () => {
    const cfg = loadConfig({ WORKMUX_CLAUDE_COMMIT_CMD: 'claude-commit' })
    expect(cfg.commitCmdFor('claude')).toBe('claude-commit')
  })

  it('should resolve OPENCODE variable for the omp kind', () => {
    const cfg = loadConfig({ WORKMUX_OPENCODE_COMMIT_CMD: 'opencode-commit -a' })
    expect(cfg.commitCmdFor('omp')).toBe('opencode-commit -a')
  })

  it('should resolve OMP variable for an opencode-reported kind', () => {
    const cfg = loadConfig({ WORKMUX_OMP_COMMIT_CMD: 'opencode-commit' })
    expect(cfg.commitCmdFor('opencode')).toBe('opencode-commit')
  })

  it('should prefer the exact-kind variable over the alias', () => {
    const cfg = loadConfig({
      WORKMUX_OMP_COMMIT_CMD: 'exact',
      WORKMUX_OPENCODE_COMMIT_CMD: 'alias',
    })
    expect(cfg.commitCmdFor('omp')).toBe('exact')
  })

  it('should ignore blank values and unknown kinds', () => {
    const cfg = loadConfig({ WORKMUX_OMP_COMMIT_CMD: '   ' })
    expect(cfg.commitCmdFor('omp')).toBeNull()
    expect(cfg.commitCmdFor('codex')).toBeNull()
    expect(cfg.commitCmdFor(null)).toBeNull()
  })

  it('should normalize punctuation in kinds', () => {
    const cfg = loadConfig({ WORKMUX_MY_AGENT_COMMIT_CMD: 'x' })
    expect(cfg.commitCmdFor('my-agent')).toBe('x')
  })

  it('should default the commit timeout to 300s and honor overrides', () => {
    expect(loadConfig({}).commitTimeoutMs).toBe(300000)
    expect(loadConfig({ WORKMUX_COMMIT_TIMEOUT_MS: '45000' }).commitTimeoutMs).toBe(45000)
  })
})

describe('loadConfig push command settings', () => {
  it('resolves WORKMUX_<KIND>_PUSH_CMD with OMP/OPENCODE aliasing', () => {
    const cfg = loadConfig({ WORKMUX_OPENCODE_PUSH_CMD: 'zsh -ic "git push -u {{REMOTE}} {{BRANCH}}"' })
    expect(cfg.pushCmdFor('omp')).toBe('zsh -ic "git push -u {{REMOTE}} {{BRANCH}}"')
    expect(cfg.pushCmdFor('opencode')).toBe('zsh -ic "git push -u {{REMOTE}} {{BRANCH}}"')
  })

  it('returns null when unset or kind is null', () => {
    const cfg = loadConfig({})
    expect(cfg.pushCmdFor('omp')).toBeNull()
    expect(cfg.pushCmdFor(null)).toBeNull()
  })

  it('normalizes non-alnum kinds', () => {
    const cfg = loadConfig({ WORKMUX_MY_AGENT_PUSH_CMD: 'x' })
    expect(cfg.pushCmdFor('my-agent')).toBe('x')
  })
})
