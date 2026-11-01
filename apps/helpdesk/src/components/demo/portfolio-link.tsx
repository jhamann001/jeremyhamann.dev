import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The public demo's way back to the portfolio site it is shown from. The demo image is built with
 * NEXT_PUBLIC_PORTFOLIO_URL; anywhere else it is unset and nothing renders. Safe in client components.
 */
export function portfolioSite(): { url: string; site: string } | null {
  const url = process.env.NEXT_PUBLIC_PORTFOLIO_URL;
  if (!url) return null;
  try {
    return { url, site: new URL(url).host };
  } catch {
    return null;
  }
}

/** "← Back to jeremyhamann.dev", as a pill. */
export function PortfolioLink({ className }: { className?: string }): React.JSX.Element | null {
  const link = portfolioSite();
  if (!link) return null;
  return (
    <a
      href={link.url}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-full border bg-card px-3 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:text-foreground md:min-h-8",
        className,
      )}
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      Back to {link.site}
    </a>
  );
}
