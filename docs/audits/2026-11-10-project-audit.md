# workmux-http project audit

Date: 2026-11-10
Status: complete; findings open, remediation not implemented.
Source baseline: `70885ca` (`docs: reorganize docs tree and define documentation lifecycle`).
Environment: macOS, Node `v26.13.0`, installed npm lockfile dependencies.
Scope: defects, safety-contract gaps, reliability, and practical optimizations.

This report follows [AGENTS.md](../../AGENTS.md) and the
[documentation lifecycle](../README.md). Current requirements remain in
[SPEC.md](../SPEC.md). This is a new audit, not a reopening of every finding
in the [2026-11-08 audit](2026-11-08-project-audit.md).

## Executive summary

The complete verification gate passes: typecheck, 475 Vitest tests across
44 files, production build, and 43 Playwright tests. `npm audit --json`
reports zero known vulnerabilities in the installed dependency tree.

Controlled probes nevertheless reproduced eight defects. The most useful
first fixes are exact-path staging, conflict rejection at the service boundary,
and honest sweep postcondition handling. Two interacting GitHub cache defects
cause unnecessary provider calls and loss of retained status. Terminal attach
failures can reserve capacity indefinitely while the failed socket stays open.
Two request-security checks accept inputs outside their documented contract.

All findings are P2: meaningful correctness or robustness defects worth fixing
in the next maintenance pass. The evidence does not establish an urgent P0/P1
incident, arbitrary code execution, or an internet-reachable exploit. Effort
labels indicate likely implementation scope, not measured delivery estimates.

## Scope, methods, and limits

Reviewed request/security validation, subprocess handling, Git adapters,
discovery and GitHub caches, sweep/management/input services, terminal lifetime,
operation polling, representative React views/dialogs, configuration, and tests.
Inspected the relevant INV-* mappings and the assertions in their referenced
tests. Passing a mapped test does not prove every case of its invariant.

- **Reproduced** means exercised through the actual service/adapter or HTTP
  routing with controlled inputs; reproduction recipes and observations follow.
- Git mutations used newly created temporary repositories only, removed afterward.
  Conflict stages were constructed with `git update-index --index-info`.
- GitHub provider calls were stubbed; clocks were controlled. No GitHub rate
  limit, provider outage, or real repository operation was induced.
- Terminal failure probes used fake sockets and tmux dependencies; they failed
  before any PTY/session creation. No messages went to real agents.
- Host probes used Fastify injection with fixture mode. The origin probe called
  the security helper directly; no browser exploit is claimed.
- The normal suite runs its disposable Git/tmux integration fixtures. Playwright
  uses Chromium with iPhone metrics, not physical iOS Safari.
- No live `/api/health` or `/api/dashboard` smoke was performed. No server source
  was modified, so the server-change smoke requirement was not triggered.
- Only this report and the documentation index change. No dependency upgrades,
  application fixes, new regression tests, commits, or pushes were performed.

Finding IDs below are local to this dated report; existing INV-* IDs are unchanged.

## Prioritized findings

| ID | Priority | Finding | Evidence | Effort |
| --- | --- | --- | --- | --- |
| F01 | P2 | Exact-path add/unstage accepts Git pathspec expansion | Reproduced add; unstage shares the mechanism | Small |
| F02 | P2 | Service permits staging unresolved conflicts | Reproduced | Small |
| F03 | P2 | Failed branch inspection can confirm sweep removal | Reproduced | Small |
| F04 | P2 | Expired GitHub successes bypass failure backoff | Reproduced | Small |
| F05 | P2 | Identity refresh evicts still-live GitHub cache entries | Reproduced | Medium |
| F06 | P2 | Failed terminal attach leaks capacity reservations | Reproduced | Small–medium |
| F07 | P2 | Host allowlist accepts inherited object properties | Reproduced through HTTP routing | Small |
| F08 | P2 | Origin comparison omits scheme | Reproduced helper mismatch | Small–medium |

### F01 — Exact-path staging expands Git pathspecs

**Location:** `server/adapters/git.ts:247` and `:255`;
`server/services/management.ts:167` and `:194`.
**Contract:** SPEC §3 add/unstage exact paths; relevant to INV-07 when an
expanded path reaches a conflict. No new invariant ID is introduced.

The service validates each requested filename against fresh status, but the
adapter passes it to `git add --` or `git restore --staged --` as a pathspec.
The separator prevents option parsing, not Git wildcard or magic interpretation.

**Reproduction:** initialize a temporary repo; create the literal file `*.txt`
and another file `secret.txt`. Provide the repo as a managed worktree and call
`Management.addPending(id, ['*.txt'])`. It returns `{ ok: true }`;
`git diff --cached --name-only` lists **both** files. No shell expansion is
involved. The same unstage argv construction has the corresponding risk,
although this audit's execution probe covered add only.

**Impact:** selection can modify unrelated index entries. This is not a proven
secret disclosure or shell-injection finding; the unintended file was staged,
not committed or pushed.

**Remediation:** make both adapter calls use literal path semantics, e.g. the
global `git --literal-pathspecs` option, while retaining fresh exact-membership
checks. Git documents this option as disabling globbing and pathspec magic in
its [command reference](https://git-scm.com/docs/git#Documentation/git.txt---literal-pathspecs).
Add real-Git tests for `*`, `?`, bracket and magic-looking filenames with
matching bystanders, verifying both add and unstage leave bystanders untouched.

**Coverage gap:** `server/adapters/git.test.ts` tests exact selections and
filename fidelity, but not wildcard/magic names with matching neighbors.
The prior filename-parsing fix does not resolve pathspec interpretation.

### F02 — Conflicted paths pass service-side add validation

**Location:** `server/services/management.ts:178`.
**Invariant:** INV-07, conflicts are awareness-only.

The fresh allowed set is built from untracked, unstaged **and conflicts**.
Thus a direct request, or a path selected before becoming conflicted, remains
eligible for `git add`. The React Add-all flow correctly excludes conflicts
already displayed; that client behavior does not close the service gap.

**Reproduction:** create base/ours/theirs blobs and stage them as index stages
1/2/3 for `conflict.txt`; write conflict markers in its worktree content.
Call `Management.addPending(id, ['conflict.txt'])`. It returns `{ ok: true }`,
and `git ls-files --unmerged` changes from three entries to empty. Git now
considers the conflict resolved in the index even though markers remain.

**Remediation:** reject any requested conflict path during locked fresh
validation, before invoking Git. Add a service regression for an unstaged path
becoming conflicted between display and submission, plus a mixed selection
whose conflict prevents all changes.

**Coverage and requirement conflict:** the mapped
`server/adapters/git.test.ts::should list unmerged paths as conflicts` checks
listing only. `DiffView.test.tsx` checks client exclusion. The historical
pending-change plan explicitly included conflicts in the API allowed set;
current SPEC INV-07 and awareness-only UI disagree with that older choice.
Resolve this in a dated feature amendment during remediation; do not weaken
INV-07 or claim the old documents were unanimously consistent.

### F03 — Sweep can report removal when branch verification failed

**Location:** `server/adapters/sweep-git.ts:165`, especially `:174`;
`server/services/sweep.ts` postcondition callers.
**Invariant:** INV-06; SPEC clean-sweep postcondition contract.

`removed()` treats every completed nonzero `git rev-parse` exit as branch
absence. Its catch handles rejected execution, but ordinary Git failures
return a result with a nonzero code. When `keepBranches=false`, a missing
directory plus a repository error can therefore produce `true`.

**Reproduction:** create an empty temporary directory with no Git repository;
use it as `projectPath`, a nonexistent child as worktree `path`, and `main`
as branch. `new SweepGit().removed(view, false)` returns **true**, although
Git cannot inspect the branch. No worktree removal was performed by this probe.

**Impact:** the service can turn an uncertain or partial result into `removed`.
This does not itself bypass the checks performed before removal.

**Remediation:** distinguish verified ref absence from repository/query errors;
propagate unverifiable postconditions so the service reports `unknown`. Test
an unavailable/non-repository parent after directory disappearance, as well
as retained and genuinely deleted branches.

**Coverage gap:** adapter postcondition tests use valid repositories. The
service test `should mark unconfirmed removals unknown even after exit zero`
uses a fake returning false and cannot catch this adapter misclassification.
Mapped source-degradation coverage checks failure before removal.

### F04 — Last-good GitHub status bypasses failure backoff

**Location:** `server/services/github-status.ts:58`, `:112`, and `:120`.
**Invariants:** INV-10 retry/freshness policy; preserve INV-06 last-good data.

Failed refreshes preserve an expired success without recording a new attempt
or retry deadline. Every subsequent `view()` after the request settles can
schedule another refresh. The 15-second delay only applies to `kind: 'fail'`
entries without a prior successful value.

**Reproduction:** stub one successful provider read, advance the controlled
clock 60,001 ms, then return `unavailable`. Make three views two seconds
apart, allowing each promise to settle. All views return `stale`, but the
provider is called four times total: the original success plus three failed
attempts in less than the configured 15-second backoff.

**Impact:** unnecessary subprocess/network work and faster consumption of
provider limits during an outage. Existing in-flight deduplication still works;
this is not simultaneous duplicate requests for one key.

**Remediation:** track last-good data separately from attempt/error/retry
metadata. Test success → expiry → failure → repeated views before and after
the retry deadline. The mapped stale-data test checks retention, while
`should retry missing gh after backoff` covers only failure without prior success.

### F05 — Identity TTL expiration discards live GitHub status

**Location:** `server/services/discovery.ts:304`, `:320`, `:328`, and the
`githubSvc.retain(githubRequests)` call; `github-status.ts:83`.
**Invariants:** INV-06 and INV-10.

At the ten-second local identity TTL, `githubFor()` starts asynchronous
resolution and returns undefined without adding the existing key to the live
request set. `retain()` then deletes that still-live worktree's cached provider
result. The next cycle starts another provider read even though its success
TTL is sixty seconds. An identity-refresh interval can also discard last-good
data precisely when it would be useful during provider failure.

**Reproduction:** create a temporary committed repo with a GitHub-shaped origin
URL; use fake workmux/tmux discovery and a counting fake GitHub provider.
After the initial identity resolution, observe `ready` with one provider call.
Advance 10,001 ms without changing HEAD/branch/remote and force a snapshot:
status becomes omitted. After identity resolution it becomes `loading`, then
`ready`, and provider calls increase to two before the 60-second TTL expires.
Only local Git config was read; the fake URL was never contacted.

**Remediation:** separate live-worktree/key retention from temporary resolution
availability; revalidate identity without treating the worktree as departed.
Preserve exact-HEAD isolation and never label a new commit with old CI.
Add an integration-level Discovery + GithubStatusService clock test crossing
both TTLs, including unchanged identity, actual identity change, and departure.

**Coverage gap:** isolated cache-retain tests and discovery join tests do not
exercise this TTL interaction. A green service-level TTL test is insufficient.

### F06 — Early terminal attach rejection consumes capacity

**Location:** `server/services/terminal.ts:105` through `:128`;
outer `handle()` catch and `cleanup()`.
**Contract:** bounded owned terminals and failure cleanup, adjacent to INV-04.

The reservation is added before awaiting discovery, pane listing, and grouped
session creation. Those awaits occur outside the try/catch that removes the
reservation. The outer catch cleans attached entries only.

**Reproduction:** configure `maxOwnedTerminals=1`, return a managed agent, and
make fake `listPanes()` reject. The first socket receives “tmux temporarily
unavailable.” An attach on a new socket then receives “advanced terminal limit
reached (1),” despite no PTY or owned session being created.

**Impact:** repeated failures can block terminal access while failed sockets
remain open. Closing or detaching those sockets releases capacity; a server
restart is not required. The current client can remain in connecting/error state.

**Remediation:** encompass all reservation-owning awaits in generation-aware
cleanup, preserving protections against older attaches clearing newer work.
Test each rejected dependency followed by a successful new attach. Existing
terminal hub capacity/cancellation tests cover pending work and cancellation,
not dependency rejection followed by capacity reuse.

### F07 — Host allowlist includes inherited object properties

**Location:** `server/security.ts:24`.
**Contract:** SPEC §2 host allowlist; no dedicated INV-* ID for the request gate.

`hostname in SAFE_HOSTNAMES` checks the object's prototype as well as its own
entries. Names such as `constructor` and `__proto__` are accepted without
configuration.

**Reproduction:** build a fixture app with default host settings and inject
GET `/api/health` with these Host values:

| Host | Observed status |
| --- | --- |
| `evil.example:3000` | 403 |
| `constructor:3000` | 200 |
| `__proto__:3000` | 200 |
| `127.0.0.1:3000` | 200 |

**Impact:** concrete allowlist-policy bypass for inherited-property names.
This is not evidence of arbitrary-domain acceptance or a working browser
DNS-rebinding exploit; DNS reachability and browser restrictions still matter.

**Remediation:** use `Set.has()` or an own-property membership check. Add
unit and route regressions for inherited names. Review other dictionary
membership checks separately rather than assuming they share the same impact.

### F08 — Origin equality does not include scheme

**Location:** `server/security.ts:29` through `:58`.
**Contract:** SPEC §2 says scheme, host, and port must match.

Origin parsing allows HTTP or HTTPS, then compares only `URL.host` with an
authority parsed using HTTP. The request type supplies no trusted scheme.

**Reproduction:** `originMatches()` returns true with Host
`127.0.0.1:3000` and Origin `https://127.0.0.1:3000` for this HTTP service.
The hostname and explicit port match, but the origins do not.

**Impact:** incomplete same-origin enforcement. The mutation header remains
required and the Host gate still applies. No practical browser attack was
demonstrated; the helper mismatch is the proven result.

**Remediation:** compare a trusted configured/request origin including scheme
and effective port. Preserve any intentionally supported HTTPS reverse-proxy
setup; do not start trusting arbitrary forwarded headers. Add scheme and
default-port cases beside existing host/port tests before changing the policy.

## Low-hanging improvements and optimizations

These are source-confirmed opportunities unless explicitly measured, not
additional demonstrated production incidents.

| ID | Priority / effort | Opportunity and suggested verification |
| --- | --- | --- |
| I01 | P3 / small | Lazy-load TerminalView and xterm. `src/App.tsx:13` imports it eagerly; the build emits one 638.66 kB JS bundle (174.46 kB gzip). Measure initial transferred/parsed JS after splitting, then rerun terminal and theme tests. No percentage saving is claimed without a comparison build. |
| I02 | P2 / medium | Recover operation UI after restart. `CreateWorktreeSheet.tsx:44` silently retries every polling error, including permanent 404, while `running` keeps close controls disabled. It also treats `unknown` as ongoing. Handle missing operations as an explicit unknown outcome and allow dismissal/rescan, following SweepSheet's existing approach. Add mocked restart/404 and transient-error tests. |
| I03 | P3 / small | Preserve commit drafts until success. `CommitBar.tsx:37` clears the textarea immediately after invoking a void callback. An API or command failure therefore loses the typed message. Keep controlled draft state until confirmed success; test failed submission and editing while pending. |
| I04 | P3 / medium | Consolidate modal accessibility. ConfirmDialog lacks focus trapping/restoration; SweepSheet lacks dialog semantics; BottomSheet only provides initial focus/Escape. Use a shared accessible dialog primitive and verify keyboard focus stays inside, returns to the trigger, and works with screen readers. No physical-device accessibility test was run. |
| I05 | P3 / medium | Bound and deduplicate discovery work. `Discovery.snapshot(true)` bypasses in-flight deduplication and any completion can replace the cache; local Git inspection loops are serial. First add a controlled out-of-order refresh test and measure subprocess counts/latency at realistic fleet sizes, then use generation ordering and bounded parallelism. Avoid unbounded Promise.all fan-out. |
| I06 | P3 / small | Release terminal generation bookkeeping. `TerminalHub.attachGen` is a strong Map of sockets and close increments rather than removes its key. A WeakMap or carefully finalized generation lifecycle would avoid retaining closed sockets. Verify cancellation races still pass and inspect retained-object growth under repeated connect/disconnect. Heap growth was not measured. |
| I07 | P3 / small | Automate the existing gate in CI if no external CI already does so. No repository `.github/` workflow directory exists. Keep native dependency setup and test skips visible; add WebKit/device coverage separately because Chromium iPhone emulation does not establish Safari behavior. External CI configuration was not inspected. |

React's [lazy reference](https://react.dev/reference/react/lazy) describes
deferring component code until first render. A named-export adapter can preserve
this repository's named-component convention; include a loading fallback and
load-error handling. Resolve F04/F05 before spending time on small render
optimizations: avoidable provider calls and dropped status have direct evidence.

## Verification results

| Check | Result | What it establishes / limits |
| --- | --- | --- |
| `npm run typecheck` | Passed | Both TypeScript projects |
| `npm test` | Passed: 475 tests, 44 files | Existing regressions; does not cover the new probe cases |
| `npm run build` | Passed | Production bundle; warning for chunk over 500 kB |
| `npm run test:e2e` | Passed: 43 tests | Fixture/mock Chromium flows at iPhone metrics |
| `npm audit --json` | Zero known vulnerabilities, exit 0 | Registry inventory at audit time, not proof of absence of vulnerabilities |
| Actual Management + temporary Git index probes | F01/F02 reproduced | No production index changed |
| Actual SweepGit postcondition probe | F03 reproduced | No removal command executed |
| Controlled provider/clock probe | F04 reproduced | No live GitHub outage or rate-limit proof |
| Discovery + cache + temporary Git repo probe | F05 reproduced | Fake provider; real local identity resolution |
| TerminalHub with failing fake dependency | F06 reproduced | No PTY/session spawned |
| Fixture HTTP injection | F07 reproduced | Actual request gate; no external browser exploit |
| Direct security-helper call | F08 reproduced | Scheme mismatch; browser exploit not tested |

The native integration suites were included in the passing Vitest run; no
skipped tests were reported. Expected test-fixture Git conflict output and
jsdom canvas warnings did not fail the gate. The build-size warning remains
an optimization opportunity, not a failed build.

## Remediation order and review

1. Fix F01/F02 together: exact literal selection and fresh conflict rejection.
   Add meaningful failing regressions first; preserve INV-07 and index contents.
2. Fix F03: unknown postconditions must not become confirmed removal.
3. Fix F07/F08 with focused request-boundary tests and explicit proxy assumptions.
4. Fix F04/F05 together, retaining exact-HEAD isolation and last-good evidence.
5. Fix F06 and operation-recovery I02; then take bundle/draft improvements.

An independent read-only review confirmed the seven initial failure mechanisms
(F01–F04 and F06–F08), checked relevant coverage, and narrowed severity/impact
claims. F05 was additionally reproduced through actual Discovery/cache
composition. Historical requirement conflicts and unmeasured optimizations are
explicitly separated from demonstrated failures.

Remediation should update the relevant feature record, tests, and any affected
SPEC mapping in the same change. This audit does not change the intended
requirements or mark any finding resolved.
