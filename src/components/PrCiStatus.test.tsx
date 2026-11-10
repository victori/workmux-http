// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GithubStatus } from '@shared/types'

import { PrCiStatus } from './PrCiStatus'

afterEach(cleanup)

const HEAD = '3f2a91c44d0e5b6a7c8d9e0f1a2b3c4d5e6f7a8b'

function status(over: Partial<GithubStatus> = {}): GithubStatus {
  return {
    state: 'ready',
    pr: null,
    ci: null,
    observedAt: Date.now(),
    attemptedAt: Date.now(),
    error: null,
    ...over,
  }
}

const openPr = (over: Partial<NonNullable<GithubStatus['pr']>> = {}) => ({
  number: 128,
  title: 'Add timezone-aware scheduling',
  url: 'https://github.com/acme/widgets/pull/128',
  state: 'open' as const,
  review: 'review_required' as const,
  headOid: HEAD,
  headRepository: 'acme/widgets',
  baseRepository: 'acme/widgets',
  baseBranch: 'main',
  ...over,
})

const ci = (over: Partial<NonNullable<GithubStatus['ci']>> = {}): NonNullable<GithubStatus['ci']> => ({
  state: 'passing',
  commitOid: HEAD,
  complete: true,
  counts: { passing: 3, failing: 0, pending: 0, neutral: 0, unknown: 0 },
  checks: [],
  ...over,
})

it('renders PR lifecycle and review status', () => {
  const { rerender } = render(<PrCiStatus status={status({ pr: openPr() })} />)
  expect(screen.getByRole('link', { name: /PR #128 · open/ })).toHaveAttribute(
    'href',
    'https://github.com/acme/widgets/pull/128',
  )
  expect(screen.getByText('review required')).toBeInTheDocument()

  rerender(<PrCiStatus status={status({ pr: openPr({ state: 'draft', review: 'unknown' }) })} />)
  expect(screen.getByText(/PR #128 · draft/)).toBeInTheDocument()

  rerender(<PrCiStatus status={status({ pr: openPr({ state: 'merged', review: 'approved' }) })} />)
  expect(screen.getByText(/PR #128 · merged/)).toBeInTheDocument()
  expect(screen.getByText('approved')).toBeInTheDocument()

  rerender(<PrCiStatus status={status({ pr: openPr({ state: 'closed', review: 'changes_requested' }) })} />)
  expect(screen.getByText(/PR #128 · closed/)).toBeInTheDocument()
  expect(screen.getByText('changes requested')).toBeInTheDocument()
})

it('renders the PR link outside any button and opens safely in a new tab', () => {
  render(<PrCiStatus status={status({ pr: openPr() })} />)
  const link = screen.getByRole('link', { name: /PR #128/ })
  expect(link.closest('button')).toBeNull()
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')
})

it('does not show unknown checks as passing', () => {
  render(
    <PrCiStatus
      status={status({
        pr: openPr(),
        ci: ci({
          state: 'unknown',
          complete: false,
          counts: { passing: 3, failing: 0, pending: 0, neutral: 0, unknown: 1 },
        }),
      })}
    />,
  )
  expect(screen.getByText(/CI checks unknown/)).toBeInTheDocument()
  expect(screen.queryByText(/CI passing/)).toBeNull()
  expect(screen.getByText('incomplete')).toBeInTheDocument()
})

it('labels stale no-PR results as historical', () => {
  render(<PrCiStatus status={status({ state: 'stale', pr: null, ci: ci() })} />)
  expect(screen.getByText('Last checked: no PR')).toBeInTheDocument()
  expect(screen.getByText(/outdated/)).toBeInTheDocument()
  expect(screen.queryByText('No PR')).toBeNull()
})

it('renders branch CI without a PR', () => {
  render(<PrCiStatus status={status({ pr: null, ci: ci() })} />)
  expect(screen.getByText('No PR')).toBeInTheDocument()
  expect(screen.getByText(/CI passing \(3✓ 0✗ 0⏳\)/)).toBeInTheDocument()
  expect(screen.getByText(/CI passing/)).toHaveAttribute('title', `checks for ${HEAD.slice(0, 7)}`)
})

it('shows failing counts and check links from the rollup', () => {
  render(
    <PrCiStatus
      status={status({
        pr: openPr(),
        ci: ci({
          state: 'failing',
          complete: true,
          counts: { passing: 1, failing: 2, pending: 0, neutral: 0, unknown: 0 },
          checks: [
            { name: 'integration', state: 'failing', url: 'https://github.com/acme/widgets/actions/runs/1' },
            { name: 'legacy', state: 'failing', url: null },
          ],
        }),
      })}
    />,
  )
  expect(screen.getByText(/CI 2 failing/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'integration' })).toHaveAttribute('href', 'https://github.com/acme/widgets/actions/runs/1')
  expect(screen.getByText('legacy')).toBeInTheDocument()
})

it('discloses unavailable and loading states without claiming offline', () => {
  const { rerender } = render(<PrCiStatus status={status({ state: 'unavailable', error: 'gh: authentication required' })} />)
  expect(screen.getByText(/GitHub unavailable/)).toBeInTheDocument()
  expect(screen.getByText(/authentication required/)).toBeInTheDocument()
  expect(screen.queryByText(/offline/i)).toBeNull()

  rerender(<PrCiStatus status={status({ state: 'loading', observedAt: null, attemptedAt: Date.now() })} />)
  expect(screen.getByRole('status')).toHaveTextContent('PR/CI loading…')

  rerender(<PrCiStatus status={status({ state: 'unsupported' })} />)
  expect(screen.getByText('GitHub unsupported')).toBeInTheDocument()

  rerender(<PrCiStatus status={undefined} />)
  expect(screen.queryByText(/PR/)).toBeNull()
})

it('surfaces the head-moved warning on historical PRs', () => {
  render(
    <PrCiStatus
      status={status({
        pr: openPr({ state: 'merged', headOid: 'b'.repeat(40) }),
        error: 'PR head differs from local HEAD (aaaaaaa)',
      })}
    />,
  )
  expect(screen.getByText(/head differs from local HEAD/)).toBeInTheDocument()
})
