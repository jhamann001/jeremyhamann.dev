import { CircleCheck, CircleOff, TriangleAlert } from "lucide-react";
import type { FlagRow } from "@/components/admin/flags/flag-catalog";
import { groupByArea } from "@/components/admin/flags/flag-catalog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * `/admin/flags` (docs/MOBILE_FIRST.md R1–R12).
 *
 * A SERVER COMPONENT with no client directive and no interactivity, because there is nothing to
 * interact with: the page is a statement of what this deployment has switched on. Config is code
 * (#73), so the way to change any of these is a deploy, and a control here would be a
 * lie about where the truth lives.
 *
 * It renders the env variable NAME and never a value — not even masked. Several of these keys are
 * credentials in a URL or maps of staff identities, and a masked secret is still a length and a
 * prefix. "Set" or "not set" is the whole of what this screen knows, and it is enough to answer the
 * question people actually open it with: is the thing I am waiting for turned on yet.
 *
 * Each row also says what happens WHILE it is off. Off is usually a deliberate, working state on this
 * desk — nothing in Wave B transmits anything and every key is unset — so a page that only printed
 * red would read as an outage rather than as the shipped configuration.
 *
 * One layout flip at `md`: stacked cards below it, a two-column grid above. Same rows, same order.
 */

export type FlagsAdminViewProps = {
  rows: FlagRow[];
  /** The deployment this page is describing, so a screenshot cannot be mistaken for another one. */
  environment: string;
};

export function FlagsAdminView({ rows, environment }: FlagsAdminViewProps): React.JSX.Element {
  const on = rows.filter((r) => r.enabled).length;
  const groups = groupByArea(rows);

  return (
    <section className="flex flex-col gap-6" data-slice="B4-flags-admin">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Capabilities</h2>
          <Badge variant="outline" className="font-normal" data-environment={environment}>
            {environment}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {on} of {rows.length} switched on. Read-only: every one of these is an environment variable
          resolved when the service starts, so changing one is a deploy and the change is visible in the
          revision. This page shows the variable&rsquo;s NAME and whether it is set — never its value,
          not even masked.
        </p>
      </header>

      {groups.map((group) => (
        <div key={group.area} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.area}</h3>
          <ul className="grid gap-2 md:grid-cols-2">
            {group.rows.map((row) => (
              <FlagCard key={row.id} row={row} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function FlagCard({ row }: { row: FlagRow }): React.JSX.Element {
  const Icon = row.partiallyConfigured ? TriangleAlert : row.enabled ? CircleCheck : CircleOff;
  return (
    <li
      data-flag={row.id}
      data-enabled={row.enabled ? "true" : "false"}
      className={cn(
        "flex flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10",
        !row.enabled && "bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0",
            row.partiallyConfigured ? "text-destructive" : row.enabled ? "text-primary" : "text-muted-foreground",
          )}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium">{row.label}</p>
          <div className="flex flex-wrap items-center gap-1">
            {/*
              The state is text as well as a colour and an icon (R10): a badge that only differed by
              hue would be unreadable to a colour-blind reader and invisible to a screen reader.
            */}
            <Badge variant={row.enabled ? "secondary" : "outline"} className="font-normal">
              {row.enabled ? "On" : "Off"}
            </Badge>
            {row.partiallyConfigured ? (
              <Badge variant="destructive" className="font-normal">
                Partly configured
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{row.enabled ? row.effect : row.whileOff}</p>

      <div className="flex flex-wrap gap-1">
        {row.envKeys.map((key) => (
          <code
            key={key}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all text-muted-foreground"
          >
            {key}
          </code>
        ))}
      </div>

      {row.envKeys.length > 1 ? (
        <p className="text-xs text-muted-foreground">All of these are needed together.</p>
      ) : null}
    </li>
  );
}
