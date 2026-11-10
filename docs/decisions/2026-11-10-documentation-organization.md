# Documentation organization and lifecycle

Date: 2026-11-10
Status: accepted
Scope: development conventions; no runtime contracts or INV-* changes.

## Context

Feature plans were split between the docs root and Superpowers directories.
Every behavior change also appended rationale to the initial scaffold plan,
making that historical plan a growing central log. Some delivered feature
records still described themselves as planning-only.

## Decision

- Keep current implemented contracts in [SPEC.md](../SPEC.md).
- Put every design in `docs/superpowers/specs/`, every implementation plan in
  `docs/superpowers/plans/`, and every audit in `docs/audits/`.
- Keep legacy combined designs/plans intact and preserve their filenames.
- Record feature rationale, dated deviations, and verification with the
  relevant feature. Use `docs/decisions/` for significant lasting decisions
  spanning features or conventions; do not duplicate every feature decision.
- Maintain a [document index](../README.md) and explicit lifecycle statuses.
- Preserve historical criteria and evidence. New decisions explicitly identify
  what they supersede and link to the earlier record; add a reciprocal link.

This supersedes the workflow requiring every later feature or fix to append
an amendment to the [initial dashboard plan](../superpowers/plans/2026-11-07-workmux-http-dashboard.md).
Its final documentation-transition amendment links here. It does not supersede
the original product requirements or runtime safety guarantees.

## Consequences and verification

[AGENTS.md](../../AGENTS.md) governs locations and lifecycle going forward.
SPEC's document map and the project README point to the new organization.
Moved references must resolve; original feature criteria remain preserved.
PR/CI and sweep status is reconciled from the recorded phase completion,
without fabricating per-task verification or historical approval.

Verify with a local Markdown/document-path reference check,
`npx vitest run server/docs.spec.test.ts`, and the existing full verification
gate. No new behavioral tests or live runtime evidence are required by the
documentation changes themselves.
