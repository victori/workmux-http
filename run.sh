#!/bin/zsh

export WORKMUX_HTTP_BIND=0.0.0.0
export WORKMUX_HTTP_ALLOW_WILDCARD=1
export WORKMUX_ALLOWED_HOSTS=*
export WORKMUX_HTTP_PORT=3000
# zsh -ic loads ~/.zshrc so its functions resolve; {{COMMIT_MSG}} is
# substituted (shell-escaped) inside the quoted -c string.
# These commit cmds are specific to my workflow, you should comment them out
export WORKMUX_OMP_COMMIT_CMD="zsh -ic 'opencode-commit -a \"{{COMMIT_MSG}}\"'"
export WORKMUX_CLAUDE_COMMIT_CMD="zsh -ic 'claude-commit -a \"{{COMMIT_MSG}}\"'"
export WORKMUX_OPENCODE_COMMIT_CMD="zsh -ic 'opencode-commit -a \"{{COMMIT_MSG}}\"'"
npm run build
npm start
