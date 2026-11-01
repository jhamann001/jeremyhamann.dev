import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueSkeleton, HomeSkeleton, FormSkeleton } from '../ui/Skeleton';

describe('Skeleton components', () => {
  it('QueueSkeleton has accessible loading attributes', () => {
    render(<QueueSkeleton />);
    const container = screen.getByRole('status');
    expect(container).toHaveAttribute('aria-busy', 'true');
    expect(container).toHaveAttribute('aria-label', 'Loading trade requests');
  });

  it('HomeSkeleton has accessible loading attributes', () => {
    render(<HomeSkeleton />);
    const container = screen.getByRole('status');
    expect(container).toHaveAttribute('aria-busy', 'true');
    expect(container).toHaveAttribute('aria-label', 'Loading dashboard');
  });

  it('FormSkeleton has accessible loading attributes', () => {
    render(<FormSkeleton />);
    const container = screen.getByRole('status');
    expect(container).toHaveAttribute('aria-busy', 'true');
    expect(container).toHaveAttribute('aria-label', 'Loading form');
  });
});
