import { ArrowLeft } from 'lucide-react';

// The public demo's way back to the portfolio site it is shown from. The demo image is built with
// VITE_PORTFOLIO_URL (see apps/trade/Dockerfile); anywhere else it is unset and nothing renders.

interface Props {
  /** What the link says (default "Back to <site>"); on narrow screens only the arrow shows when `compact`. */
  label?: string;
  compact?: boolean;
  className?: string;
}

export function PortfolioLink({ label, compact = false, className = '' }: Props) {
  const url = import.meta.env.VITE_PORTFOLIO_URL;
  if (!url) return null;
  const site = new URL(url).host;
  const text = label ?? `Back to ${site}`;
  return (
    <a
      href={url}
      // Keeps the visible words in the name, and names the link when `compact` hides them.
      aria-label={label ? `${label}, back to ${site}` : text}
      className={`inline-flex items-center gap-1.5 text-[13px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors ${className}`}
    >
      <ArrowLeft size={14} aria-hidden />
      <span className={compact ? 'hidden sm:inline' : undefined}>{text}</span>
    </a>
  );
}
