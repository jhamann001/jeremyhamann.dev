import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DriftCoverageStatus } from '@trade-request/shared';
import { DriftStatusBadge } from '../ui/DriftStatusBadge';

const STATUSES: DriftCoverageStatus[] = ['full', 'partial', 'engine_only', 'meridian_only', 'unmapped_account'];

const EXPECTED_LABELS: Record<DriftCoverageStatus, string> = {
  full: 'Full',
  partial: 'Partial',
  engine_only: 'Engine only',
  meridian_only: 'Meridian only',
  unmapped_account: 'Unmapped',
};

describe('DriftStatusBadge', () => {
  it.each(STATUSES)('renders the human-friendly label for "%s"', (status) => {
    render(<DriftStatusBadge status={status} />);
    expect(screen.getByText(EXPECTED_LABELS[status])).toBeInTheDocument();
  });

  it.each(STATUSES)('sets a non-empty title and aria-label for "%s"', (status) => {
    render(<DriftStatusBadge status={status} />);
    const badge = screen.getByText(EXPECTED_LABELS[status]);
    expect(badge.getAttribute('title')).toBeTruthy();
    expect(badge.getAttribute('aria-label')).toContain(EXPECTED_LABELS[status]);
  });

  it('renders distinct styles for distinct statuses (no shared className collision)', () => {
    const { container: c1 } = render(<DriftStatusBadge status="full" />);
    const { container: c2 } = render(<DriftStatusBadge status="unmapped_account" />);
    expect(c1.querySelector('span')!.className).not.toBe(c2.querySelector('span')!.className);
  });
});
