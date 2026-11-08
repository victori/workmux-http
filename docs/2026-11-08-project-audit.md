# workmux-http Project Audit

Date: 2026-11-08

Source baseline: `89d3ce0` (`feat(worktrees): disable commit-now when clean, server rejects nothing_to_commit`)

Environment: macOS, Node `v26.13.0`, installed lockfile dependencies

Disposition: audit only; no application fixes, commits, or pushes performed.

## Executive summary

The project has a useful, relatively small architecture: shared TypeScript
contracts, explicit process adapters, managed-target validation, a separate
Reader view, and substantial real-git/tmux and browser coverage. The no-login
VPN model is an intentional design choice, not itself a defect.

However, the current implementation should not be treated as ready for broader
deployment. A reproduced URL-normalization bug bypasses the HTTP security
hook, and supported configurable shell wrappers can execute commit-message
substitutions. Background mutation serialization and asynchronous terminal
attachment also have safety gaps. Fix these before adding more management
capabilities or expanding network reachability.

All 247 Vitest assertions pass, but the command exits nonzero because of an
uncaught test error. The production build and all 26 Playwright tests pass.
Passing tests therefore do not establish the safety guarantees at issue here.

## Scope and evidence

Reviewed server request validation/security, discovery, subprocess handling,
management actions, operation tracking, terminal ownership, git parsing, client
polling, Reader/Terminal behavior, dialogs, configuration, and verification.

Evidence labels used below:

- **Reproduced:** exercised the defect in a controlled local probe.
- **Source-confirmed:** identified a concrete implementation gap, without
  claiming a production incident or an end-to-end exploit.
- **Registry-reported:** returned by `npm audit`; applicability is conditional
  and is not equivalent to demonstrated application exploitability.

Safety boundaries of this audit:

- HTTP mutation probes used fixture mode only; no messages went to real agents.
- Terminal races used fake tmux/PTY dependencies. The pane-selection check
  used a separately named disposable tmux server running only `sleep`.
- Shell interpolation was demonstrated with `printf`, not filesystem changes
  or external commands with side effects.
- Git path checks used an isolated temporary repository, removed afterward.
- Browser sizing checks used the production build and a mocked WebSocket.
- Existing tests create their own disposable git/tmux fixtures. No production
  service, home-directory integration, dependency, or application source was
  modified for this report.
- Documentation changes appeared concurrently during the audit; they were
  left untouched. Findings refer to the inspected application source.

## Prioritized findings

P1 = address before release/network expansion; P2 = important correctness or
reliability fix; P3 = lower-impact contract/maintenance issue. Severity reflects
this VPN-bound operator tool, not an assumption that it is public Internet SaaS.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| F01 | P1 | Encoded API paths bypass the HTTP request guard | Reproduced |
| F02 | P1 | Shell-wrapper commit interpolation is not reliably inert | Reproduced |
| F03 | P1 | Worktree lock ends before background mutations finish | Reproduced with stubbed operations |
| F04 | P1 | Pending terminal attachments evade limits and disconnect cleanup | Reproduced with fake PTYs |
| F05 | P1 | Terminal attachment can target a different active pane | Reproduced tmux selection semantics; source-confirmed input path |
| F06 | P1 | Verification gate is currently failing despite green assertions | Reproduced |
| F07 | P1 | Dependency audit reports production and development advisories | Registry-reported |
| F08 | P2 | Confirmation expiry is not enforced at execution | Reproduced with stubbed actions |
| F09 | P2 | Mobile terminal fit measures the expanded grid, not the viewport | Reproduced in Chromium |
| F10 | P2 | Quoted git filenames cannot reliably be staged | Reproduced |
| F11 | P2 | A hung fetch can permanently suppress polling and leave stale status | Source-confirmed |
| F12 | P3 | Some invalid API inputs return HTTP 500 instead of 400 | Reproduced |

### F01 — Encoded API paths bypass the security hook

Location: `server/index.ts:122`, especially the raw
`req.url.startsWith('/api/')` test at line 123.

Fastify resolves percent-encoded static path characters, but the security hook
checks the undecoded URL. Consequently, `/%61pi/...` reaches an `/api/...`
handler without invoking Host, Origin, or mutation-header validation.

Controlled fixture-mode probe, with no `x-workmux-request` header:

```text
Host: untrusted.example
Origin: http://other.example
Content-Type: application/json
Body: {"text":"AUDIT FIXTURE ONLY","requestId":"audit-boundary"}

POST /api/agents/%25287/messages
403 {"error":"forbidden_host"}

POST /%61pi/agents/%25287/messages
200 {"delivered":"sent","requestId":"audit-boundary",
     "paneId":"%287","detail":"fixture"}
```

An encoded GET to `/%61pi/health` likewise returns JSON with an otherwise
forbidden Host. This bypass is independently reproduced in the application's
hook; it is not merely inferred from dependency advisories.

Impact: the browser/DNS-rebinding defenses documented for HTTP routes can be
skipped. Network reachability is still required; this is not a claim that an
unreachable VPN service becomes reachable from the Internet. The WebSocket
handler has an additional explicit security check and was not shown to have
this particular bypass.

Recommendation: attach security to the API route scope or route metadata, or
apply the guard globally, rather than classifying routes by a raw URL prefix.
Avoid an ad hoc decode-once solution that diverges from router normalization.
Add encoded-static-path GET and POST regressions for Host, Origin, and missing
header rejection, alongside canonical-path controls.

### F02 — Shell-wrapper escaping is not a shell parser

Location: `server/commitCmd.ts:45`, `server/commitCmd.ts:49`, and
`server/commitCmd.ts:56`; shell-wrapper usage is documented in README.

The double/single-quote regex substitutions do not understand escaped quotes
or general shell syntax. A documented category of trusted configuration can
therefore cause an untrusted message to be interpreted as shell code.

Harmless reproduction through `buildCommitArgv` followed by `exec.run`:

```text
Configured command:
sh -c 'printf "%s\n" "prefix\"{{COMMIT_MSG}}suffix"'

Message:
$(printf AUDIT_MARKER)

Observed stdout:
prefix"'AUDIT_MARKER'suffix
```

The literal `$(printf AUDIT_MARKER)` is absent from the result: its command
substitution executed. This requires a vulnerable shell-wrapper configuration;
the default direct argv path is not demonstrated vulnerable. Operators already
have substantial intentional power through Terminal, but this still violates
the promised data-only treatment of commit messages.

Recommendation: prohibit interpolation into shell program text. Pass messages
as whole argv elements/positional parameters, for example a constant
`sh -c 'tool "$1"' _ {{COMMIT_MSG}}` wrapper, or use an external wrapper
executable. Reject unsupported shell-substring templates with a clear migration
error. Add executable round-trip tests, not only assertions about generated
backslashes. Include escaped quotes, command substitutions, backticks, newlines,
and nested quoting.

### F03 — Worktree locks serialize operation creation, not execution

Location: `server/services/management.ts:386`,
`server/services/management.ts:410`, `server/services/management.ts:494`, and
`server/services/operations.ts:27`.

`locked()` awaits `runAction()`, but `runAction()` returns as soon as
`Operations.start()` starts an asynchronous callback. The lock releases while
the actual merge/remove/push is still running. Direct commit, path staging,
and hunk actions do not consistently share this lock either.

A controlled probe returned immediate stub operation views while keeping their
background jobs pending. Two confirmed actions for the same fake target
produced a peak of **two active background jobs**, despite the worktree lock.
No real destructive operation was run.

Impact: two browsers can race destructive commands or mutate an index during a
commit. Confirmation evaluation also occurs before entering the lock, so state
may change while an action waits.

Recommendation: hold a per-worktree mutation lock until actual operation
completion, or reject conflicting actions with a busy response. Revalidate
confirmation state inside the execution boundary. Define whether staging,
commit, merge, push, remove, open, and close conflict, and use one policy.
Test with a gated fake command and a second request from another client.
Desktop/agent mutations remain outside this web-only lock and need normal git
conflict/staleness handling.

### F04 — Terminal attach has pending-state and cleanup races

Location: `server/index.ts:353`, `server/services/terminal.ts:77`,
`server/services/terminal.ts:84`, and `server/services/terminal.ts:120`.

WebSocket messages launch `handle()` without serialization. Attachment checks
the active-map limit before several awaits, and only registers ownership after
creating the session and PTY. `close()` cannot cancel an attachment that has not
yet entered that map.

Controlled probe with fake PTYs:

```text
configuredLimit: 1
concurrent pending attachments: 2
first socket closed before dependencies were released
PTYs spawned after release: 2
owned entries after completion: 2
```

Repeated attaches on one socket can similarly leave multiple sessions behind.
An old PTY's exit callback unconditionally deletes the socket's entry, which
can erase a newer attachment. Async `killOwnedSession()` calls also lack error
handling on several cleanup paths.

Recommendation: reserve capacity synchronously, track pending attaches by
socket/generation, cancel on close/detach, and check cancellation after awaits.
Serialize control messages or otherwise make reattach atomic. Exit callbacks
must only remove their own attachment. Bound terminal output buffering using
WebSocket backpressure, and handle cleanup rejection explicitly. Add dedicated
TerminalHub lifecycle tests; current client mocks and geometry tests do not
cover these interleavings.

### F05 — Terminal input follows the window's active pane

Location: `server/services/terminal.ts:90`,
`server/services/terminal.ts:99`, and the raw `pty.write` path at line 61.

The hub validates an agent pane but attaches a tmux client to its window. It
selects the window, not the requested pane. Grouped sessions share windows and
their active-pane state.

Disposable-tmux probe with two harmless panes:

```text
requestedPane: %0
parentActivePane: %1
groupedSessionActivePane: %1
```

Thus opening Terminal for a non-active agent pane can present another pane
and route keystrokes there, while retaining the requested agent's label. No
keystrokes were sent in the probe. Standard tmux interaction can also move the
attached client elsewhere; this is not pane-scoped input enforcement.

Recommendation: explicitly decide whether Terminal grants full session access
or promises agent-pane scope. For full-session access, disclose the actual
active pane and detect/report target changes. For pane-scoped access, use a
design that actually enforces that boundary. Do not silently fix this by
selecting the shared pane and unexpectedly moving the desktop. Add split-pane
integration tests before retaining an agent-specific input guarantee.

### F06 — The Vitest gate is red despite 247 passing assertions

Location: `src/features/worktrees/DiffView.test.tsx:237`,
`src/features/worktrees/DiffView.tsx:129`.

`npm test` reports 29 passed files and 247 passed tests, then exits **1** due to
an uncaught `TypeError: Cannot read properties of undefined (reading 'then')`.
The “lists untracked, unstaged, and conflicts with add controls” test clicks
Add all without giving `mockApi.addPaths` a Promise-returning implementation.
The call assertion passes while the event handler throws.

Recommendation: initialize the mock response and assert the resulting UI state
or failure handling. Keep unhandled errors fatal; do not hide them with a global
exception filter. Rerun the focused DiffView tests and the full suite. Canvas
and localStorage warnings also merit quieter, explicit test shims, but are not
the cause of this command's failure.

### F07 — Dependency advisories need triage and planned upgrades

Location: `package.json`, `package-lock.json`.

Registry results obtained during this audit:

| Command | Result |
| --- | --- |
| `npm audit --json` | 6 affected package entries: 2 critical, 1 high, 3 moderate |
| `npm audit --omit=dev --json` | 3 production entries: 1 high, 2 moderate |

Installed affected trees include:

- Production: `@fastify/static@8.3.0` → `glob@11.1.0` → `minimatch@10.2.6`.
- Development: `vitest@3.2.7`, `@vitest/mocker@3.2.7`, `tinypool@1.1.1`.

Relevant advisory references returned by the registry include:

- Static route guards/path normalization:
  https://github.com/advisories/GHSA-x428-ghpx-8j92,
  https://github.com/advisories/GHSA-8pvw-jcv7-9cmj,
  https://github.com/advisories/GHSA-83w8-p2f5-377r.
- Vitest mock endpoints: https://github.com/advisories/GHSA-82fw-gwwq-j7x9
  and https://github.com/advisories/GHSA-qxg6-89mg-rqv8.
- Tinypool prototype-pollution gadgets:
  https://github.com/advisories/GHSA-5gmw-xhrv-c9v3
  and https://github.com/advisories/GHSA-85c8-ppgw-ccpr.

These counts include transitive/meta-vulnerability entries, not six independent
confirmed exploits. Directory listing, development-server exposure, attacker
control of patterns/options, and pre-existing prototype pollution affect
applicability. No production RCE from these dependencies was demonstrated.

Recommendation: review each advisory against deployed configuration, upgrade
compatible trees, and rerun all checks. The registry proposes major upgrades
for `@fastify/static` and Vitest; do not blindly apply `npm audit fix --force`.
Do not expose test/mock development servers on the VPN without a deliberate
access policy. Dependency upgrades do not replace the F01 application fix.

### F08 — Confirmation tokens do not expire at execute time

Location: `server/services/management.ts:347`,
`server/services/management.ts:365`, and `server/services/management.ts:504`.

Expired entries are pruned when preparing another action. Execution checks
existence and state, but never compares `issued.at` with the configured
five-minute TTL. An old token remains usable if no later prepare has pruned it.

Controlled probe: prepared a fake action, advanced its issuance timestamp to
older than `BOUNDS.confirmTokenTtlMs`, then executed against a stub runner.
Execution returned a running operation rather than rejecting the token.

Recommendation: enforce expiry at execution before consuming/using a token;
retain synchronous single-use consumption. Test TTL boundaries, an expired
token without an intervening prepare, and concurrent executes. Separately,
bound outstanding token count so prepare bursts cannot grow memory unchecked.

### F09 — Resize-to-fit uses the already expanded terminal width

Location: `src/features/terminal/TerminalView.tsx:238`,
`src/features/terminal/TerminalView.tsx:257`, and
`src/features/terminal/TerminalView.tsx:329`.

The inner terminal container is expanded to the server grid's width for
horizontal scrolling. FitAddon then measures that expanded container rather
than the visible phone viewport. The action can increase column count instead
of making the terminal fit.

Production-build Chromium probe with an iPhone 13 device context:

```text
viewport width: 390px
terminal viewport clientWidth: 390px
terminal viewport scrollWidth: 1072px
server grid: 132 columns × 43 rows
confirmed fit frame: 145 columns × 28 rows
```

The existing e2e checks that a fit frame exists and its label changes, but not
whether those dimensions fit the screen. `fit.fit()` also resizes xterm locally
before the server acknowledgment, so rejection/disconnect can leave a local
grid inconsistent with the server size.

Recommendation: derive a proposal from the outer visible viewport using
supported terminal measurements, while retaining the inner grid for scrolling.
Only update the live grid after acknowledgment, or explicitly restore it on
failure. Assert actual pixel fit, dimension bounds, and rejected-resize behavior
in browser tests. Verify on actual iOS Safari; this probe was Chromium only.

### F10 — Line-based git status parsing loses filename fidelity

Location: `server/adapters/git.ts:38`, `server/adapters/git.ts:58`, and
`server/adapters/git.ts:105`.

Porcelain v2 without `-z` C-quotes certain filenames. Untracked paths are
returned verbatim, while tracked parsing only partially unescapes them. Rename
records also require careful destination/source separation rather than a
literal `': '` assumption.

Reproduction in a temporary repository with `core.quotePath=true`:

```text
actual filename: café.txt
repoStatus().untracked: ["\"caf\\303\\251.txt\""]
git.addPaths(status.untracked):
fatal: pathspec '"caf\303\251.txt"' did not match any files
```

Recommendation: consume `git status --porcelain=v2 -z --branch -uall` and parse
NUL-delimited ordinary, rename/copy, unmerged, and untracked records correctly.
Test Unicode, quotes, backslashes, tabs, newlines, spaces, and renames. Keep
path validation and argv `--` separation; display formatting must not change
the exact path sent back to git.

### F11 — Hung requests can freeze polling indefinitely

Location: `src/lib/api.ts:51`, `src/hooks/useDashboard.ts:50`,
`src/hooks/useDashboard.ts:98`, and `src/features/agent/OutputPane.tsx:72`.

The API client uses `fetch` without a deadline or cancellation. Dashboard and
Reader polling hold an in-flight flag until settlement. A request that stays
pending prevents subsequent refreshes, including foreground recovery. The
dashboard freshness derivation uses wall-clock time, but has no independent
clock update to trigger rendering while that request hangs.

Impact: a stalled proxy/network can leave old output and potentially an Online
banner visible without successful polling. This is source-confirmed; it was
not simulated against a production VPN or claimed as an observed incident.

Recommendation: use bounded AbortController deadlines for reads, cancel
obsolete fetches, and recompute freshness on a clock independent of successful
responses. Never automatically retry ambiguous mutations as a side effect of
adding generic retry logic. Test a never-resolving read, visible/online events,
timeout recovery, pause/resume, and unmount cleanup.

### F12 — Zod parse exceptions escape as internal errors

Location: `server/index.ts:26`, the dashboard handler, and other direct
`.parse()` route calls without a shared Zod error handler.

Fixture injection of `GET /api/dashboard?force=wrong` returns HTTP **500** with
a serialized validation message, rather than the documented **400**
`invalid_request` contract. Mutation bodies using `safeParse()` do not have the
same behavior.

Recommendation: add centralized Zod error translation or consistently use
`safeParse()` for params/queries as well as bodies. Test malformed and overlong
IDs, invalid query enums, and unexpected fields according to a documented
policy. Return bounded client-appropriate details, not internal exceptions.

## Additional suggestions

These are improvement opportunities or follow-up investigations, not all
confirmed defects with the same priority as the findings above.

1. **Add a CI release gate.** No `.github` workflow was present in the inspected
   checkout. Run typecheck, Vitest with fatal unhandled errors, build, and
   fixture e2e in a reproducible environment. Make skipped native/tmux coverage
   explicit rather than treating a skipped suite as a live integration proof.
2. **Test WebKit and real iOS.** The project named “iPhone Safari-like” actually
   runs Chromium. Add WebKit coverage where supported and maintain a short
   real-device checklist for keyboard, viewport, background/resume, selection,
   and horizontal terminal scrolling. Label evidence accurately.
3. **Improve modal accessibility.** `ConfirmDialog` declares `aria-modal` but
   has no focus management, focus trap, or restoration. `BottomSheet` focuses
   an element but also lacks trapping/restoration. Add keyboard/assistive-tech
   tests, avoid accidental background actions, and constrain large confirmation
   content to the viewport with an internally scrolling body.
4. **Make mutations recoverable, not blindly retryable.** Creation accepts a
   `requestId` but `Management.create()` does not deduplicate it; execution
   accepts one but uses only the single-use token. Direct commit has no such
   client key. Define idempotent acceptance and operation lookup so a dropped
   response can be recovered without starting another job. In-memory operation
   state is lost on restart; explicitly surface that uncertainty.
5. **Bound load and retained state.** Limit active operations, pending input,
   outstanding prepares, and WebSocket buffered output. Prune idle per-target
   queue/cache entries. `Operations` limits finished history only on a later
   start, not active concurrency. Validate positive, finite numeric config
   values, especially terminal limits and subprocess timeouts.
6. **Reduce discovery latency and forced-refresh amplification.** Git/PR
   enrichment is awaited sequentially across agents/worktrees. Forced snapshots
   bypass in-flight deduplication, allowing concurrent expensive builds and
   older completion to overwrite a newer cache. Use bounded enrichment
   concurrency, retain in-flight sharing for forced refreshes, and track
   generation ordering. Measure multi-repository latency before tuning TTLs.
7. **Lazy-load the advanced terminal.** The production build reports one
   616.59 kB JavaScript chunk, 168.84 kB gzip, and a >500 kB chunk warning.
   Dynamically importing TerminalView/xterm would reduce initial Reader load
   on a phone. Benchmark startup rather than merely increasing the warning
   threshold.
8. **Improve diagnostics and contract accuracy.** Fastify logging is disabled;
   consider structured opt-in error/operation logs without prompts, terminal
   contents, or credentials. Revisit output-route catch-all HTTP 410: a timeout
   or tmux dependency failure is not proof that the pane ended. Review remove
   warnings: ahead-of-upstream from `repoStatus()` is not the same fact as
   unmerged-into-base. Keep distinct concepts explicit in contracts and UI.
9. **Preserve the network threat model.** Keep wildcard Host opt-in, never
   broaden bind defaults, and document reverse-proxy/VPN ACL requirements.
   Add a deployment checklist rather than silently introducing application
   authentication or implying Host validation authenticates native clients.

## Verification results

| Check | Outcome | What it establishes |
| --- | --- | --- |
| `npm run typecheck` | Passed, exit 0 | Current app/server TypeScript checks |
| `npm test` | Exit 1; 29 files / 247 assertions passed; 1 uncaught error | Not a green release gate; see F06 |
| `npm run build` | Passed, exit 0; chunk warning | Production bundle and server compilation |
| `npm run test:e2e` | 26 passed, exit 0 | Fixture Chromium flows, with mocked terminal happy path |
| `npm audit --json` | Vulnerabilities reported | Registry advisory inventory, not exploit proof |
| `npm audit --omit=dev --json` | Vulnerabilities reported | Production-tree advisory subset |
| Controlled HTTP injection | F01 and F12 reproduced | In-process real routing/hooks with fixture services |
| Controlled shell invocation | F02 reproduced | Message expansion under the stated wrapper configuration |
| Stubbed management/PTY probes | F03, F04, F08 reproduced | Application sequencing/expiry, without live mutations |
| Disposable tmux selection | F05 reproduced | Grouped-session active-pane semantics |
| Production-build mobile Chromium | F09 reproduced | Actual measured container and outgoing fit frame |
| Temporary git repository | F10 reproduced | Filename fidelity under standard quotePath behavior |

The initial chained verification command stopped at the Vitest failure.
Build and e2e were then run separately and passed. The real-tmux integration
suite ran during Vitest (7 tests), rather than being skipped in this environment.
No live production API smoke or physical iOS-device test was performed, and no
claim of those proofs is made. No external Postman workspace was created or
modified; existing Vitest/Fastify injection and fixture Playwright harnesses
provided the local API evidence.

## Suggested remediation order

1. **Close the security holes:** F01 and F02; add executable regressions and
   retain current VPN-only deployment limits.
2. **Restore mutation/terminal safety:** F03, F04, F05, and F08; agree on the
   intended terminal scope before implementing pane selection changes.
3. **Restore trustworthy verification:** fix F06, triage F07, and add CI. All
   new regressions should fail against this baseline and pass after fixes.
4. **Finish mobile correctness:** F09, actual Safari checks, and dialog focus
   behavior. Do not equate a fit acknowledgment with successful viewport fit.
5. **Harden reliability and contracts:** F10–F12, bounded requests/concurrency,
   operation recovery, discovery scaling, and code splitting.

This report is a snapshot, not a proof of absence of other defects. Findings
were manually reviewed a second time against their source locations and probe
outputs. The report does not change the canonical feature spec; fixes that
change behavior should update README and append the required spec amendments
alongside implementation and verification results.
