# Dashboard agent kind badge

- Date: 2026-11-14
- Status: implemented
- Related design and plan: this combined record
- Current behavior: [SPEC §8](../../SPEC.md#8-ui-capability-inventory-behavioral-not-visual)
- Affected invariants: none change. INV-01 and INV-06 remain relevant because
  the label uses existing managed-agent discovery data and its freshness rules.

Agent kind previously appeared after elapsed time in the same truncating row as
project and branch. Put the Workmux-reported kind in a badge before the project
so standard agent names have space on narrow cards. Preserve custom names and
omit the badge when the field is missing. Workmux status supplies the agent
kind and has no model field.

Verify that the card labels reported kinds and omits missing values, then run
the discovery tests and repository verification gate.

## Verification

2026-11-14: The four reported-kind assertions failed before the badge change
and passed afterward. All 47 focused card, discovery (INV-01 and INV-06), and
spec checks passed. Live Workmux status reported `omp` for the pictured pane.
An isolated copy of HEAD with the badge changes passed type checking, the
production build, and all 43 Playwright checks, including badge visibility at
the iPhone 13 viewport. The isolated Vitest run passed 479 tests and failed the
three unrelated native sweep checks, which assumed a worktree path that was
absent. The shared checkout also had concurrent server type errors and a
native sweep failure.
