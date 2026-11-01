import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tooltip } from '../ui/Tooltip';

describe('Tooltip', () => {
  it('renders children and tooltip text', () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>,
    );
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text');
  });

  it('links trigger to tooltip via aria-describedby', () => {
    render(
      <Tooltip content="Description">
        <span>Target</span>
      </Tooltip>,
    );
    const trigger = screen.getByText('Target').closest('[aria-describedby]')!;
    const tooltipId = trigger.getAttribute('aria-describedby');
    expect(tooltipId).toBeTruthy();
    expect(screen.getByRole('tooltip')).toHaveAttribute('id', tooltipId);
  });

  it('is focusable via tabIndex', () => {
    render(
      <Tooltip content="Info">
        <span>Focusable</span>
      </Tooltip>,
    );
    const trigger = screen.getByText('Focusable').closest('[tabindex]')!;
    expect(trigger).toHaveAttribute('tabindex', '0');
  });

  it('renders children only when content is empty', () => {
    render(
      <Tooltip content="">
        <span>No tooltip</span>
      </Tooltip>,
    );
    expect(screen.getByText('No tooltip')).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
