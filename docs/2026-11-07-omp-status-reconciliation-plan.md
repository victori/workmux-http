# Fix plan: OMP reports Done while work continues

## Goal and scope

Fix false completion reports at the OMP/workmux integration boundary, and make
the web dashboard clear about what its status actually means. A web-only label
change cannot fix the same incorrect status in workmux's native sidebar.

This document authorizes no implementation, installation, agent restart,
commit, or push. Implementers must recheck repository instructions and the
current working tree. Another agent is actively working here; do not overwrite
its changes. Existing project files are currently untracked: back up each
existing untracked file with a timestamped `.bak` before modifying it.

## Evidence and limits

Observed on November 7, 2026, America/Los_Angeles:

- Installed workmux: `0.1.280`; installed OMP: `18.18.0`.
- `workmux status --all --json` identifies the affected agent as OMP in pane
  `%319`, session `shellfish-2`, window `omp`, project `workmux-http`.
- Workmux logged `set-window-status done` for that pane at
  `2026-11-08T00:24:03.444158Z` (4:24:03 PM local). The state file had
  `status: done` and `updated_ts: 1794097443`.
- Later pane captures showed active generation, tool output, and one running
  subagent. Later session records also showed tool calls. No subsequent
  `working` report for that pane appeared in the inspected log interval.
- `~/.omp/agent/extensions/workmux-status.ts` unconditionally sends `done` on
  `agent_end`; it sends `working` on `agent_start`, non-ask `tool_call`, and
  `tool_execution_start`. It also deduplicates using extension-local
  `lastStatus` and serializes reports using extension-local `statusQueue`.
- `server/services/discovery.ts` trusts known upstream status values, subject
  to its elapsed-time stale threshold. `server/adapters/workmux.ts` validates
  the payload, but cannot establish that a reported completion is true.

Confirmed: upstream status disagrees with actual activity, and the HTTP app
inherits it. Not yet confirmed: whether child agents overwrite the parent's
status, resumed execution misses lifecycle events, report failures are
suppressed, or another integration writes the same pane. Do not present any
one of these hypotheses as established fact.

## Design constraints

- Keep reported lifecycle status separate from process liveness and output
  activity. A running OMP process can legitimately be idle after finishing.
- Do not infer Working from process existence, spinner/title text, changed
  output, or a running Node server. Output may be unrelated to agent work.
- Do not infer Done from silence or a timeout. Long model/tool waits are valid.
- Preserve managed-only target checks, socket isolation, and read-only
  discovery. Never rewrite workmux state files or send synthetic status reports
  from the HTTP poller to conceal this bug.
- Never select or resize desktop panes for detection. Use the existing
  argv-only subprocess gateway for any server-side diagnostic query.
- No new API endpoint is required for the baseline fix. No automatic edits to
  home-directory extensions or Homebrew-installed files on server startup.

## Phase 1 — Establish the lifecycle contract (blocking investigation)

Owner: integration worker. Do this before choosing the hook algorithm.

1. Inspect the installed OMP extension API and event dispatcher for this exact
   version. Identify the supported way to distinguish the root interactive
   session from task/subagent sessions, and to detect a resumed turn or queued
   continuation. Verify whether the current extension runs in child sessions.
2. Check all status writers, including Pi/OMP extensions and any agent-driven
   shell calls. Determine whether child sessions inherit the root tmux pane
   environment. A per-extension promise queue cannot coordinate independent
   extension instances writing the same pane.
3. Reproduce in a disposable tmux socket with a temporary test project and
   isolated OMP configuration. Mock workmux writes to record event name,
   session/parent identity, pane, lifecycle transition, exit code, and sequence.
   Avoid recording prompts, credentials, or session contents.
4. Exercise parent work with a short child that finishes first, overlapping
   children, a long child, steering input, queued follow-up, tool waits,
   cancellation, and a resumed/reloaded session.
5. Produce a short evidence note naming the actual failing event sequence and
   supported API fields. If the runtime exposes insufficient lifecycle data,
   stop the hook patch at that boundary and document the required upstream OMP
   change; do not invent event names or rely on undocumented private fields.

Deliverable: a deterministic failing regression test, not merely a live
observation or a force-set Working workaround.

## Phase 2 — Fix the source integration

Suggested new write scope: `integrations/omp/` (hook, lifecycle helper, tests,
installation notes). Keep a versioned candidate here rather than silently
patching the live extension. Check Vitest discovery/configuration before
choosing test placement; do not assume a new folder is automatically included.

Implementation requirements, selected using Phase 1 evidence:

1. Only the root interactive owner may publish the root pane's status. Use
   supported runtime identity/context; do not use an unconditional global
   disable for child work if the root cannot observe its completion.
2. Model root activity explicitly. Publish Working on genuine root start or
   resume; Waiting only for a supported user-input boundary; Done only when
   the root lifecycle is complete and no owned continuation remains. Track
   children only if their lifecycle is needed and supported by the root API.
3. Serialize writes within the owner and prevent obsolete completion writes
   from winning after a newer start/resume. Test interleaved event order, not
   just sequential happy paths.
4. Preserve prompt forwarding and shell/Python/slash-command exclusions from
   the existing extension. Preserve ask-tool waiting semantics.
5. Advance the deduplication state only after a successful report. The current
   implementation assigns `lastStatus` before completion and discards errors;
   verify OMP's exec result shape and handle nonzero exit codes as failures.
   A failed write must not permanently suppress the same next desired status.
   Keep retries bounded; avoid unbounded queues or background timers that leak.
6. Reset/reconcile lifecycle and deduplication state on supported session
   start/reload paths. Never seed Done solely because an extension loaded.

Installation is a separate, explicitly approved operation: first save a
timestamped backup of `~/.omp/agent/extensions/workmux-status.ts`, install the
tested candidate, and follow OMP's verified reload procedure. Do not interrupt
the current agent to test this. Document restore/reload rollback instructions.
Warn that `workmux setup` or an upstream upgrade may replace the local hook.

## Phase 3 — Make the dashboard honest about provenance

Owner: HTTP/UI worker. Can proceed in parallel with Phase 1, using this fixed
contract: keep `AgentStatus` and API status values unchanged for the baseline.

Write scope: status presentation under `src/components/` and
`src/features/{dashboard,agent}/`, relevant tests, and README status guidance.

1. Explain that Done means the last workmux lifecycle report said the turn
   ended, not that the process exited or every background task finished.
   Prefer concise visible wording such as “Reported done” on agent badges;
   retain the semantic status value `done` for filtering and sorting.
2. Show accessible provenance/help and the report timestamp using existing
   `AgentView.updatedTs`. Label elapsed time accurately; do not call
   `elapsedSecs` “time since last output.” Validate upstream timestamp semantics
   before promising a precise “last transition” meaning.
3. Cover dashboard cards, agent detail, and agent switcher consistently.
   Explain worktree dots are upstream summary statuses, not independently
   verified completion. Do not imply that a fresh successful HTTP poll proves
   the underlying lifecycle report is current.
4. Keep existing source-failure and stale behavior intact. An old Done report
   may be legitimate; age alone does not prove hook failure. Do not change the
   stale threshold as a substitute for fixing this incident.

Optional follow-up, not baseline scope: structured status provenance/activity
fields. If needed, agree the contract in `shared/types.ts` first, then update
adapters, Discovery, fixture mode, all test builders, and consumers together.
Output-derived evidence must remain explicitly heuristic, never authoritative.

## Regression matrix and verification

Integration regression tests must establish:

- Root busy + child completes => no false root Done.
- Root continues after a wait/steering/queued prompt => Working is published.
- Root truly completes => Done appears; idle live process stays Done.
- Ask starts/finishes => Waiting/Working transitions stay correct.
- New root activity cannot be overwritten by an obsolete completion.
- Failed/nonzero workmux write => dedup permits a later valid same-state write.
- Reload, cancellation, child failure, and overlapping children leave no
  stuck Working state and no leaked queues/timers.
- Separate panes and sockets cannot affect one another.

HTTP/UI regression tests must establish:

- Discovery faithfully preserves a recent upstream Done report; it does not
  substitute Working because the pane process is alive.
- Existing stale threshold, last-good/source failure behavior, and managed-only
  filtering remain unchanged.
- Agent badges/help expose reported completion and report age accessibly;
  sorting/filtering still use `done`. Worktree summary presentation is clear.

Start with the narrowest relevant tests:

```sh
npx vitest run server/services/discovery.test.ts
npx vitest run src/features/dashboard/DashboardView.test.tsx src/features/agent/AgentView.test.tsx
# Also run the new lifecycle/extension tests and status-component tests.
```

After integration, run the repository gate:

```sh
npm run typecheck && npm test && npm run build && npm run test:e2e
```

Use temporary fixture data and a disposable tmux socket for reproduction.
Live acceptance is read-only until installation is approved: compare pane
activity, `workmux status --all --json`, and `/api/dashboard`. Never send test
prompts or keys to real agents. For server changes also smoke `/api/health`.

## Handoff and acceptance

- Integration worker owns Phase 1/2; UI worker owns Phase 3. Their file scopes
  are disjoint. No worker edits the live home-directory hook by default.
- Integrator reviews the actual diffs and event evidence, resolves contract
  changes if any, runs combined verification, and performs a second-pass review
  for races, missing tests, privacy, and unsafe assumptions.
- Completion requires a proven lifecycle fix plus regression coverage, not
  just more cautious UI wording. If only Phase 3 ships, label it a mitigation
  and leave the upstream lifecycle bug explicitly open.
- Report changed paths, commands/results, required installation/reload steps,
  and remaining uncertainties. Do not commit or push.
