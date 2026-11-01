import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DriftBreachBadge } from '../ui/DriftBreachBadge';
import type { DriftBadgeKind } from '../../utils/driftBadge';

const KINDS: DriftBadgeKind[] = ['clean', 'would-alert', 'allow-listed', 'unmapped'];

const EXPECTED_LABELS: Record<DriftBadgeKind, string> = {
  clean: 'Clean',
  'would-alert': 'Would alert',
  'allow-listed': 'Allow-listed',
  unmapped: 'Unmapped',
};

describe('DriftBreachBadge', () => {
  it.each(KINDS)('renders the human-friendly label for "%s"', (kind) => {
    render(<DriftBreachBadge kind={kind} />);
    expect(screen.getByText(EXPECTED_LABELS[kind])).toBeInTheDocument();
  });

  it.each(KINDS)('sets a non-empty title and aria-label for "%s"', (kind) => {
    render(<DriftBreachBadge kind={kind} />);
    const badge = screen.getByText(EXPECTED_LABELS[kind]);
    expect(badge.getAttribute('title')).toBeTruthy();
    expect(badge.getAttribute('aria-label')).toContain(EXPECTED_LABELS[kind]);
  });

  it('uses the optional tooltip prop instead of the default description when supplied', () => {
    render(<DriftBreachBadge kind="allow-listed" tooltip="Known divergence — awaiting mirror mode" />);
    const badge = screen.getByText('Allow-listed');
    expect(badge.getAttribute('title')).toBe('Known divergence — awaiting mirror mode');
  });

  it('renders distinct styles per kind (no shared className collision)', () => {
    const { container: c1 } = render(<DriftBreachBadge kind="clean" />);
    const { container: c2 } = render(<DriftBreachBadge kind="would-alert" />);
    expect(c1.querySelector('span')!.className).not.toBe(c2.querySelector('span')!.className);
  });
});
