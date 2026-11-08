#!/bin/zsh

export WORKMUX_HTTP_BIND=0.0.0.0
export WORKMUX_HTTP_ALLOW_WILDCARD=1
export WORKMUX_ALLOWED_HOSTS=*
export WORKMUX_HTTP_PORT=3000
# zsh -ic loads ~/.zshrc so its functions resolve; `_` is $0, the commit
# message is appended by the dashboard and lands as "$@" (one argv element).
export WORKMUX_OMP_COMMIT_CMD="zsh -ic 'opencode-commit -a \"\$@\"' _"
export WORKMUX_CLAUDE_COMMIT_CMD="zsh -ic 'claude-commit -a \"\$@\"' _"
export WORKMUX_OPENCODE_COMMIT_CMD="zsh -ic 'opencode-commit -a \"\$@\"' _"
npm run build
npm start
