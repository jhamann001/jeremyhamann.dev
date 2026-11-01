import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../ui/StatusBadge';
import type { RequestStatus } from '@trade-request/shared';

const STATUSES: RequestStatus[] = [
  'Pending Review',
  'Needs Info',
  'Pending Current Asset Liquidation',
  'Approved',
  'Completed',
  'Rejected',
];

describe('StatusBadge', () => {
  it.each(STATUSES)('renders "%s" with correct text', (status) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
  });

  it('has a title attribute with the status description', () => {
    render(<StatusBadge status="Pending Review" />);
    expect(screen.getByText('Pending Review')).toHaveAttribute('title', 'Awaiting trader review');
  });

  it('renders each status with unique styling', () => {
    const { container: c1 } = render(<StatusBadge status="Approved" />);
    const { container: c2 } = render(<StatusBadge status="Rejected" />);

    const span1 = c1.querySelector('span')!;
    const span2 = c2.querySelector('span')!;
    expect(span1.className).not.toBe(span2.className);
  });
});
