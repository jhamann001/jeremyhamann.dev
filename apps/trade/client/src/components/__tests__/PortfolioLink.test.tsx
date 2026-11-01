import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PortfolioLink } from '../PortfolioLink';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PortfolioLink', () => {
  it('links back to the portfolio site in the public demo', () => {
    vi.stubEnv('VITE_PORTFOLIO_URL', 'https://jeremyhamann.dev');
    render(<PortfolioLink />);
    const link = screen.getByRole('link', { name: 'Back to jeremyhamann.dev' });
    expect(link).toHaveAttribute('href', 'https://jeremyhamann.dev');
    expect(link).toHaveTextContent('Back to jeremyhamann.dev');
  });

  it('can say something shorter', () => {
    vi.stubEnv('VITE_PORTFOLIO_URL', 'https://jeremyhamann.dev');
    render(<PortfolioLink label="Portfolio" compact />);
    expect(screen.getByRole('link', { name: 'Portfolio, back to jeremyhamann.dev' })).toHaveTextContent('Portfolio');
  });

  it('renders nothing outside the public demo', () => {
    vi.stubEnv('VITE_PORTFOLIO_URL', '');
    const { container } = render(<PortfolioLink />);
    expect(container).toBeEmptyDOMElement();
  });
});
