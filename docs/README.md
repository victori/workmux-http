# Documentation index

Start with [SPEC.md](SPEC.md) for current implemented behavior and
[the project README](../README.md) for setup and usage.
[AGENTS.md](../AGENTS.md) defines contributor and agent workflow rules.

## Locations and roles

| Location | Purpose |
| --- | --- |
| `SPEC.md` | Living contracts, invariants, state machines, and test mappings |
| `superpowers/specs/YYYY-MM-DD-<topic>-design.md` | Proposed behavior, rationale, failure cases, and acceptance criteria |
| `superpowers/plans/YYYY-MM-DD-<topic>.md` | Implementation tasks and verification; legacy combined designs/plans stay together |
| `decisions/YYYY-MM-DD-<topic>.md` | Significant lasting decisions spanning features or development conventions |
| `audits/YYYY-MM-DD-<topic>.md` | Dated findings, evidence, and resolution references |
| `screenshots/` | User-facing screenshots |

These locations apply to all authors and tools, whether Superpowers is used
or not. Keep dated plans out of the `docs/` root. Preserve existing filenames
and completed records in place; repair links whenever a document moves.

## Lifecycle

Designs and plans use `draft`, `approved`, `in-progress`, `implemented`,
`superseded`, or `abandoned`. New records include Date, Status, links to the
related design/plan, affected SPEC sections and INV-* IDs (or why none apply),
and Verification (initially pending). Small changes can use one combined
record. Historical documents retain their original formats and evidence.

1. Describe the proposed delta against SPEC and define acceptance criteria.
2. Record approval when given, then plan tasks and observable verification.
3. Update code, tests, and current-state SPEC together as behavior lands.
4. Reconcile status here and in the feature records; record dated verification,
   deviations, and remaining limits. Partial delivery remains `in-progress`.
5. Preserve original criteria. Add dated follow-ups or link a superseding
   decision both ways rather than silently rewriting past intent.

Completed plans are historical evidence, not current contracts. Unchecked
historical task lists do not override dated completion evidence or establish
that each task was verified. Do not copy proposed features into current-state
SPEC before implementation. Never infer approval from a document's presence.

## Feature records

Statuses below reflect existing completion records, not new live verification.

| Feature | Design / plan | Status |
| --- | --- | --- |
| Initial dashboard | [Combined design and plan](superpowers/plans/2026-11-07-workmux-http-dashboard.md) | implemented; historical amendments |
| Themes | [Combined design and plan](superpowers/plans/2026-11-07-theme-support.md) | implemented |
| Reader / Terminal modes | [Combined design and plan](superpowers/plans/2026-11-07-reader-terminal-modes-plan.md) | implemented |
| Pending changes and configurable commit | [Combined design and plan](superpowers/plans/2026-11-07-untracked-commit-plan.md) | implemented |
| Push and unpushed indicator | [Combined design and plan](superpowers/plans/2026-11-07-push-button-plan.md) | implemented |
| Pending-changes badge | [Combined design and plan](superpowers/plans/2026-11-07-pending-changes-badge-plan.md) | implemented |
| OMP status reconciliation | [Investigation and plan](superpowers/plans/2026-11-07-omp-status-reconciliation-plan.md) | draft; not implemented per 2026-11-08 record |
| Restore staged files | [Combined design and plan](superpowers/plans/2026-11-08-unstage-pending-plan.md) | implemented |
| Commit history | [Combined design and plan](superpowers/plans/2026-11-08-commit-log-plan.md) | implemented |
| PR/CI status and clean sweep | [Design](superpowers/specs/2026-11-09-pr-ci-status-and-clean-sweep-design.md) · [Plan](superpowers/plans/2026-11-09-pr-ci-status-and-clean-sweep.md) | implemented; both phases |

## Decisions and audits

- [Project audit, 2026-11-10](audits/2026-11-10-project-audit.md): complete;
  eight open reproduced defects and seven improvement opportunities. Full
  verification gate passes; remediation is not implemented.
- [Documentation organization](decisions/2026-11-10-documentation-organization.md):
  accepted; explains the transition from a global scaffold amendment log to
  feature records and lasting decisions.
- [Project audit, 2026-11-08](audits/2026-11-08-project-audit.md): historical
  report; F01–F12 remediation is recorded in the scaffold amendments.

Historical references to the “canonical plan” refer to the initial dashboard
plan. Its original criteria and amendments are retained. As of the 2026-11-10
transition, future decisions and verification belong with their feature or
in `decisions/`, not as unrelated additions to that scaffold plan.
