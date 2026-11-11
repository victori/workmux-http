# Project defect review

Date: 2026-11-11 (workspace task date).
Status: complete; findings below remain open.
Baseline: `a05a590`, initially clean working tree.
Scope: Git/index integrity, management queues, terminal lifecycle, request
security, sweep outcomes, frontend staging, and existing regression coverage.

The complete verification gate passes: typecheck, **526 Vitest tests in 46
files**, build, and **47 Playwright tests**. The registry audit reports zero
known dependency vulnerabilities. Controlled probes nevertheless reproduce
the twelve P2 defects below. P2 means a concrete maintenance defect; it does
not claim an urgent production incident or a demonstrated remote exploit.

Current requirements remain in [SPEC.md](../SPEC.md). This review does not
change application behavior or weaken those requirements. Only this report
and [the documentation index](../README.md) are changed.

## Findings, in recommended repair order

### F01 — Hunk content can change the file being staged

Location: `server/hunks.ts:88`; `server/hunks.ts:89`.
Contract: SPEC §3, stage the selected file/hunk.

The parser handles `--- ` and `+++ ` as file headers even after entering a
hunk. An added source line beginning `++ ` therefore replaces `current.path`.
The reconstructed patch uses the substituted name.

**Reproduced:** commit a disposable `f.txt` containing `old\n`, then replace
its contents with `++ unexpected-path\n`. `Management.diff()` reports the
file as `unexpected-path`; staging its hunk returns `ok: true`. Inspecting
the real index shows **deletion of `f.txt` and addition of `unexpected-path`**,
instead of a modification to `f.txt`. Worktree files are not deleted by this
probe, but a subsequent commit would record the unintended file identity.

Parse headers only in the header phase and treat hunk lines as content.
Add a real-Git regression asserting both the staged content and exact index
filenames. Existing parser tests exercise ordinary header/content lines only.

### F02 — Exact-path staging and unstaging expand Git pathspecs

Location: `server/adapters/git.ts:248`; `server/adapters/git.ts:256`.
Contract: SPEC §3 exact paths; also relevant to INV-07.
Previously reported: [2026-11-10 F01](2026-11-10-project-audit.md#f01--exact-path-staging-expands-git-pathspecs).

`--` terminates options but does not disable Git wildcard/magic matching.
Fresh membership validation of the requested filename cannot prevent that
subsequent expansion.

**Reproduced through Management:** create literal `*.txt` and `bystander.txt`.
Adding only `*.txt` stages both. Unstaging only `*.txt` then unstages both.
Both service calls return `ok: true`.

Use literal path semantics for both commands and retain exact-membership
validation. Test wildcard/magic-looking filenames with matching bystanders;
the existing filename and selection tests do not establish this property.

### F03 — Add accepts unresolved conflicts

Location: `server/services/management.ts:179`.
Invariant: **INV-07**, conflicts are awareness-only.
Previously reported: [2026-11-10 F02](2026-11-10-project-audit.md#f02--conflicted-paths-pass-service-side-add-validation).

The service's fresh allowed set explicitly includes `status.conflicts`.
The UI excludes displayed conflicts, but a stale selection or direct request
can still stage one.

**Reproduced:** create stages 1/2/3 for `conflict.txt` using
`git update-index --index-info`, leaving conflict markers in its worktree
content. `addPending(id, ['conflict.txt'])` returns `ok: true`;
`git ls-files --unmerged` changes from three entries to empty. The unresolved
content is now recorded as resolved in the index.

Reject conflicting paths before any add. The INV-07 mapped test asserts
conflict listing only; add a service test for a displayed path becoming
conflicted before submission, including mixed selections.

### F04 — Queued writes retain authorization from before the lock

Location: `server/services/management.ts:169`; `server/services/management.ts:177`.
Invariant: **INV-01**, managed-only validation at execution time.

`addPending`, `unstagePending`, `commitWorktree`, and `hunkAction` resolve
the worktree before waiting on its mutation lock. Inside the lock they reuse
that object without checking whether discovery still manages the target.

**Reproduced for add:** hold a TargetLocks gate, queue an add for a managed
temporary repository, remove the target from the fake discovery map, then
release the gate. The add returns `ok: true` and stages the file. The repository
still exists, so Git itself cannot detect that management authorization ended.

Resolve and validate the target again inside the locked callback. The mapped
unmanaged-target tests reject targets absent at request entry; the SPEC
already records the missing queued-disappearance regression. The other three
methods share the source pattern but were not independently exercised here.

### F05 — Closely spaced split pieces are not independent applicable patches

Location: `server/hunks.ts:184`.
Contract: SPEC §3, split and stage one hunk piece.

Splitting blindly extends each change group by three raw diff lines on both
sides. Those lines can contain the neighboring group's additions/deletions,
instead of unchanged context. EOF markers can also fall outside the slice.

**Reproduced:** change lines two and four of a seven-line file, leaving line
three unchanged. Split returns two pieces, but each includes both EDIT-A and
EDIT-B. Staging the first piece through Management fails with `patch does not
apply`. Separate adapter probes for both pieces also fail. No claim is made
that this particular fixture successfully stages both edits.

Build each piece from its own changes and valid old-side context, preserving
EOF semantics. The real-Git split regression uses wider spacing and does not
cover one/two-line gaps. Test close gaps, insert/delete combinations, and
files with and without a final newline.

### F06 — Deleted and Git-quoted paths cannot be staged as hunks

Location: `server/hunks.ts:88`; `server/hunks.ts:134`.
Contract: SPEC §3 and §8 diff/hunk controls.

The parser stores the deletion sentinel `/dev/null` as the file's path;
the patch builder then prefixes it with `b/`. Quoted Git filenames are
retained with their quotes/escaped bytes and prefixed again as well.

**Reproduced:** deleting tracked `f.txt` produces a diff entry named
`/dev/null`; stage fails with `bad git-diff - expected /dev/null`.
With `core.quotePath=true`, editing `café.txt` produces a path containing
`"b/caf\303\251.txt"`; stage fails because the reconstructed quoted path
does not exist in the index. The initial Unicode probe inherited a local
quotePath setting and succeeded; explicitly enabling the standard quoting
behavior reproduced the defect.

Separate actual file identity from old/new patch sentinels, decode Git's
quoted names correctly, and serialize valid patch headers. Existing status
filename tests exercise NUL-delimited porcelain, not diff/patch round trips.

### F07 — Successful hunk staging immediately removes its Undo control

Location: `src/features/worktrees/DiffView.tsx:74`; `:228`.
Contract: SPEC §8 hunk stage/unstage UI.

Stage success sets `stagedKeys` or `stagedPieces`, then immediately reloads.
The reload clears both sets and the split-piece map. Since the WIP diff is
against HEAD, staging does not remove the displayed hunk. The control returns
to Stage instead of offering Undo.

**Reproduced in production-build Chromium with intercepted API responses:**
stage one hunk; the second diff response correctly reports its file staged.
The UI displays `hunk staged`, zero Undo buttons, and one Stage button.
Whole-file Restore remains available, but cannot undo only a selected hunk.

Represent staged hunk state in the response or preserve/reconcile it against
unchanged patch identity. Test the controls after the successful refetch;
the current component staging test checks the API call/refetch only.

### F08 — Restore fails before the first commit

Location: `server/adapters/git.ts:256`.
Contract: SPEC §5 pending changes and §8 Restore controls.

`git restore --staged` defaults to HEAD, which does not exist in an unborn
repository. The UI nevertheless lists staged files and offers Restore there.

**Reproduced through Management:** initialize an empty repository, add
`first.txt`, then unstage it. Add succeeds; unstage throws
`fatal: could not resolve 'HEAD'`.

Handle the unborn index explicitly while preserving worktree contents,
literal-path behavior, and conflict exclusions. Add a real-Git test of the
complete add/restore cycle before the first commit.

### F09 — Early terminal failures consume unused capacity

Location: `server/services/terminal.ts:105`; `:114`; `:127`.
Contract: SPEC §6 pending capacity and cleanup; adjacent to INV-04.
Previously reported: [2026-11-10 F06](2026-11-10-project-audit.md#f06--early-terminal-attach-rejection-consumes-capacity).

The reservation is made before discovery, listPanes, and grouped-session
creation, but these awaits are outside the cleanup try/catch. The outer
handler's cleanup only removes completed attachments.

**Reproduced with fake sockets/dependencies:** limit one, managed agent,
listPanes rejects. The first socket receives `tmux unavailable`; a second
receives `advanced terminal limit reached (1)`. Owned sessions remain empty.
Closing/detaching the failed socket releases the reservation.

Protect all reservation-owning awaits with generation-aware cleanup.
Existing capacity/cancellation tests omit early dependency rejection followed
by capacity reuse. No native PTY or real session was created by this probe.

### F10 — Sweep treats a failed branch query as proof of deletion

Location: `server/adapters/sweep-git.ts:174`.
Invariant: **INV-06**, report uncertain outcomes honestly.
Previously reported: [2026-11-10 F03](2026-11-10-project-audit.md#f03--sweep-can-report-removal-when-branch-verification-failed).

Any completed nonzero `rev-parse` result becomes `exists=false`, including
fatal repository failures. The rejection handler does not catch normal
nonzero process results.

**Reproduced:** use a nonexistent worktree directory, an existing non-Git
parent directory, branch `main`, and `keepBranches=false`. `removed()` returns
true although Git cannot inspect the branch. Sweep callers use that true
value to classify ambiguous removal as confirmed.

Distinguish verified ref absence from failed inspection, propagating the
latter as unknown. Adapter tests use valid parents; the service's fake-false
postcondition test cannot expose this adapter misclassification.

### F11 — Host allowlist accepts inherited object properties

Location: `server/security.ts:24`.
Contract: SPEC §2 Host gate; no dedicated INV-* ID.
Previously reported: [2026-11-10 F07](2026-11-10-project-audit.md#f07--host-allowlist-includes-inherited-object-properties).

`hostname in SAFE_HOSTNAMES` includes properties inherited from Object's
prototype. Default fixture HTTP injection returns 403 for `evil.example:3000`
but 200 for both `constructor:3000` and `__proto__:3000`.

Use a Set or an own-property test, with route regressions. This is a confirmed
allowlist mismatch, not proof of practical DNS rebinding in a browser.

### F12 — Origin matching ignores the scheme

Location: `server/security.ts:29`; `server/security.ts:58`.
Contract: SPEC §2 scheme+host+port equality; no dedicated INV-* ID.
Previously reported: [2026-11-10 F08](2026-11-10-project-audit.md#f08--origin-equality-does-not-include-scheme).

The helper accepts HTTP and HTTPS but compares only their authorities.
For HTTP Host `127.0.0.1:3000`, Origin `https://127.0.0.1:3000` returns true
in the controlled helper probe.

Compare trusted scheme and effective authority, accounting explicitly for
supported reverse proxies without trusting arbitrary forwarded headers.
The mutation-header gate still applies; no browser exploit was demonstrated.

## Additional review notes

- **Queued token expiry needs an explicit policy/test (INV-02).** A controlled
  fake-clock probe accepted a stop request before expiry, held its lock,
  advanced past the TTL, then observed the fake kill run. Management checks
  expiry at acceptance only; Sweep rechecks when each target runs. Whether
  an already-accepted queued management operation must expire is not explicit
  enough to count this as another definite defect here.
- **Creation recovery remains fragile.** Source inspection at
  `src/features/worktrees/CreateWorktreeSheet.tsx:44` shows permanent operation
  404s swallowed as transient failures while `running` disables dismissal.
  This was already noted as I02 in the preceding audit; no additional
  restart/browser reproduction was performed in this review.
- **Earlier GitHub findings are not blindly repeated.** Current
  `GithubStatusService.recordFailure()` records retry metadata while retaining
  last-good data, and discovery retains cached identity during refresh.
  These address the mechanisms of the preceding audit's F04/F05. The full
  existing tests pass; this review does not claim a new combined-TTL closure
  test or live GitHub outage proof.
- **Documentation drift remains.** SPEC §6 describes `attach {paneId}` and
  `error {message}`, while the actual schema/types use `agentId` and `error`.
  SPEC also describes the Host allowlist as port-exact although its code
  compares hostnames. Resolve intended policy before changing either side.
- The build still emits one approximately **646 kB** minified JS chunk
  (**176.64 kB** gzip). Terminal lazy loading remains a performance opportunity,
  not a measured startup regression from this review.

## Verification and limits

| Check | Result / scope |
| --- | --- |
| `npm run typecheck` | Passed, both projects |
| `npm test` | Passed, 526 tests / 46 files; no skipped tests reported |
| `npm run build` | Passed; >500 kB bundle warning |
| `npm run test:e2e` | Passed, 47 Chromium tests with iPhone metrics |
| `npm audit --json` | Zero known registry vulnerabilities |
| Controlled Git probes | Real adapter/service mutations in disposable repositories, removed afterward |
| Queue/terminal probes | Fake discovery, clocks, socket/dependency boundaries; no real agent input |
| Security probes | Fixture Fastify injection and direct origin-helper call |
| Hunk UI probe | Production build, fixture server, intercepted diff/stage responses; post-refetch DOM assertions |

Reviewed the relevant INV-01/04/06/07 mappings and their test assertions.
The passing gate does not cover the newly reproduced cases; proposed tests
above are follow-up work, not tests added by this audit. Findings were checked
again against source and probe outputs before finalizing, including the
unsuccessful split application and quotePath-dependent Unicode behavior.

The fixture server's health/dashboard were read during browser setup. No live
production API smoke, physical iOS Safari check, or external-service failure
experiment was performed. No production repository, agent session, application
source, dependency version, commit, or remote was changed.
