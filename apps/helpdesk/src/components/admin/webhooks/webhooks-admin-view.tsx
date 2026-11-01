"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Radio } from "lucide-react";
import type { WebhookDeliveryDTO, WebhookEndpointDTO } from "@/types/domain";
import { WEBHOOK_DELIVERY_STATUS_LABELS } from "@/types/domain";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WebhookEditSheet } from "@/components/admin/webhooks/webhook-edit-sheet";
import { WebhookRevokeDialog } from "@/components/admin/webhooks/webhook-revoke-dialog";
import { WebhookTestButton } from "@/components/admin/webhooks/webhook-test-button";
import {
  DELIVERY_STATUS_VARIANTS,
  ENDPOINT_HEALTH_LABELS,
  endpointHealth,
  eventLabel,
  shortUrl,
} from "@/components/admin/webhooks/webhook-form-support";
import { cn } from "@/lib/utils";

/**
 * `/admin/webhooks` (docs/MOBILE_FIRST.md R1–R12).
 *
 * Mobile-first with one layout flip at `md`, the same shape `/admin/macros` uses: below it each
 * endpoint is a stacked card whose controls are full width; from `md` the same card lays out in a row.
 * Same data, same component, same list in both — there is no phone-only view to keep in step.
 *
 * Filtering is client-side. The endpoint list is a handful of rows and it is all loaded already; a
 * round trip per keystroke would buy nothing, and there is no "link me every revoked endpoint"
 * workflow. Recorded in the integration notes, as `/admin/macros` recorded the same departure.
 *
 * The banner at the top is not decoration. Every screen in this section describes machinery that is
 * currently switched off, and an operator who configures an endpoint and then waits for a delivery
 * that can never come has been misled by the UI. So the page says it in one line, from a flag resolved
 * on the server and passed as a prop (G1: a client component may not read `@/lib/env`).
 */

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "revoked", label: "Revoked" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

function matchesFilter(endpoint: WebhookEndpointDTO, filter: StatusFilter): boolean {
  if (filter === "live") return endpoint.revokedAt === null;
  if (filter === "revoked") return endpoint.revokedAt !== null;
  return true;
}

export type WebhooksAdminViewProps = {
  endpoints: WebhookEndpointDTO[];
  deliveries: WebhookDeliveryDTO[];
  /** `env.WEBHOOKS_ENABLED`, resolved server-side. */
  webhooksEnabled: boolean;
};

export function WebhooksAdminView({
  endpoints,
  deliveries,
  webhooksEnabled,
}: WebhooksAdminViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const visible = useMemo(() => endpoints.filter((e) => matchesFilter(e, filter)), [endpoints, filter]);
  const liveCount = endpoints.filter((e) => e.revokedAt === null && e.isActive).length;
  const nameById = useMemo(() => new Map(endpoints.map((e) => [e.id, e.name])), [endpoints]);

  return (
    <section className="flex flex-col gap-4" data-slice="B5-webhooks-admin">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Outbound event endpoints and their delivery history. A payload carries ids, the WM number, queue, status,
            priority and timestamps — never a subject, a body, or anything identifying the requester.
          </p>
        </div>
        <WebhookEditSheet mode="create" className="w-full md:w-auto md:shrink-0" />
      </header>

      {webhooksEnabled ? null : (
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-3 text-sm">
          <Radio aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Sending is switched off.</span> Endpoints can be configured
            and deliveries are recorded, but nothing is transmitted until <code>WEBHOOKS_ENABLED</code> is set on the
            service. Queued rows wait; they are not lost.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter endpoints">
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f.key}
            type="button"
            variant={f.key === filter ? "secondary" : "outline"}
            size="sm"
            // R3: the global phone rule sets a 44 px minimum height but no minimum width, so a short
            // label needs the width floor too.
            className="min-w-11"
            aria-pressed={f.key === filter}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <span className="flex min-h-11 items-center text-xs text-muted-foreground">
          {liveCount} live of {endpoints.length}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {endpoints.length === 0
            ? "No endpoints yet. Create one to push ticket events to another system."
            : "No endpoints match this filter."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} webhooksEnabled={webhooksEnabled} />
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="webhook-deliveries-heading">
        <div className="flex flex-col gap-1">
          <h3 id="webhook-deliveries-heading" className="text-base font-semibold">
            Recent deliveries
          </h3>
          <p className="text-sm text-muted-foreground">
            The most recent attempts across every endpoint, newest first. A failed delivery is retried with a widening
            gap and then gives up; the audit log holds every transition.
          </p>
        </div>

        {deliveries.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing has been queued yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deliveries.map((delivery) => (
              <DeliveryRow key={delivery.id} delivery={delivery} endpointName={nameById.get(delivery.endpointId)} />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function EndpointCard({
  endpoint,
  webhooksEnabled,
}: {
  endpoint: WebhookEndpointDTO;
  webhooksEnabled: boolean;
}): React.JSX.Element {
  const health = endpointHealth(endpoint);
  const revoked = health === "revoked";

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground",
        revoked && "opacity-70",
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{endpoint.name}</span>
            <Badge variant={health === "live" ? "secondary" : revoked ? "outline" : "destructive"}>
              {ENDPOINT_HEALTH_LABELS[health]}
            </Badge>
            {endpoint.recentFailures > 0 ? (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle aria-hidden className="size-3" />
                {endpoint.recentFailures} failing
              </Badge>
            ) : null}
          </div>
          {/* The full URL is the title-less truth for a wide screen; the short form is what a phone
              can actually read. Both are text, so neither is tooltip-only (R10). */}
          <span className="truncate font-mono text-xs text-muted-foreground md:hidden">{shortUrl(endpoint.url)}</span>
          <span className="hidden truncate font-mono text-xs text-muted-foreground md:inline">{endpoint.url}</span>
          <span className="text-xs text-muted-foreground">
            Secret <span className="font-mono">{endpoint.secretPrefix}…</span> · created{" "}
            {formatDateTime(endpoint.createdAt)}
            {endpoint.revokedAt === null ? null : ` · revoked ${formatDateTime(endpoint.revokedAt)}`}
          </span>
        </div>

        {revoked ? null : (
          <div className="flex flex-col gap-2 md:flex-row md:shrink-0">
            <WebhookEditSheet mode="edit" endpoint={endpoint} className="w-full md:w-auto" />
            <WebhookTestButton
              endpointId={endpoint.id}
              name={endpoint.name}
              disabled={!endpoint.isActive}
              webhooksEnabled={webhooksEnabled}
              className="w-full md:w-auto"
            />
            <WebhookRevokeDialog endpointId={endpoint.id} name={endpoint.name} className="w-full md:w-auto" />
          </div>
        )}
      </div>

      <ul className="flex flex-wrap gap-1.5" aria-label={`Events ${endpoint.name} receives`}>
        {endpoint.events.length === 0 ? (
          <li className="text-xs text-muted-foreground">No events — this endpoint receives nothing.</li>
        ) : (
          endpoint.events.map((action) => (
            <li key={action}>
              <Badge variant="outline" className="font-normal">
                {eventLabel(action)}
              </Badge>
            </li>
          ))
        )}
      </ul>
    </li>
  );
}

function DeliveryRow({
  delivery,
  endpointName,
}: {
  delivery: WebhookDeliveryDTO;
  endpointName: string | undefined;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-1 rounded-lg border p-3 md:flex-row md:items-center md:justify-between md:gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={DELIVERY_STATUS_VARIANTS[delivery.status]}>
            {WEBHOOK_DELIVERY_STATUS_LABELS[delivery.status]}
          </Badge>
          <span className="font-mono text-xs">{delivery.eventAction}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {endpointName ?? "unknown endpoint"} · seq {delivery.auditSeq} · {delivery.attempts}{" "}
          {delivery.attempts === 1 ? "attempt" : "attempts"}
          {delivery.responseStatus === null ? "" : ` · HTTP ${delivery.responseStatus}`}
        </span>
        {delivery.lastError === null ? null : (
          <span className="text-xs text-destructive">{delivery.lastError}</span>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {delivery.sentAt === null ? formatDateTime(delivery.createdAt) : formatDateTime(delivery.sentAt)}
      </span>
    </li>
  );
}
