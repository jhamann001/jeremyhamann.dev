import { ArrowLeft } from "lucide-react";

// The public demo's way back to the portfolio site it is shown from. The demo image is built with
// NEXT_PUBLIC_PORTFOLIO_URL; anywhere else it is unset and nothing renders.

export function portfolio(): { url: string; site: string } | null {
  const url = process.env.NEXT_PUBLIC_PORTFOLIO_URL;
  if (!url) return null;
  try {
    return { url, site: new URL(url).host };
  } catch {
    return null;
  }
}

/** The pill on the sign-in page and the advisor view: "← Back to jeremyhamann.dev". */
export function PortfolioLink({ className = "" }: { className?: string }) {
  const link = portfolio();
  if (!link) return null;
  return (
    <a
      href={link.url}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-card-border bg-[var(--bg-card)] px-3 py-1 text-[12.5px] font-medium text-muted-strong shadow-sm transition hover:text-foreground ${className}`}
    >
      <ArrowLeft size={13} aria-hidden />
      Back to {link.site}
    </a>
  );
}

/** The advisor header's back button on phones, sized like the header's other buttons. */
export function PortfolioIconLink({ className = "" }: { className?: string }) {
  const link = portfolio();
  if (!link) return null;
  return (
    <a
      href={link.url}
      aria-label={`Back to ${link.site}`}
      title={`Back to ${link.site}`}
      className={`flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground ${className}`}
    >
      <ArrowLeft size={14} aria-hidden />
    </a>
  );
}

/** The nav rail's icon button, named for screen readers and shown as a tooltip. */
export function PortfolioRailLink() {
  const link = portfolio();
  if (!link) return null;
  return (
    <a
      href={link.url}
      aria-label={`Back to ${link.site}`}
      title={`Back to ${link.site}`}
      className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
    >
      <ArrowLeft size={15} aria-hidden />
    </a>
  );
}
