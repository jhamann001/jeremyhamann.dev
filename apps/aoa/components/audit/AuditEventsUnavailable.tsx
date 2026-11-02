"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RememberedListLink } from "@/components/navigation/RememberedListLink";
import { Card, CardBody, CardHeader } from "@/components/ui";

/** A failed read preserves the shell, current filters and a manual retry. */
export function AuditEventsUnavailable({ scope }: { scope: string }) {
  const router = useRouter();
  const [pending, transition] = useTransition();
  return <>
    <nav aria-label="Audit view" style={{ display: "flex", gap: 6, margin: "16px 0" }}>
      <RememberedListLink scope={scope} href="/audit-log" match={{ view: "" }} active>Events</RememberedListLink>
      <RememberedListLink scope={scope} href="/audit-log?view=changes" match={{ view: "changes" }}>Field changes</RememberedListLink>
    </nav>
    <Card><CardHeader><h2>Events</h2></CardHeader><CardBody>
      <p role="status">Audit events could not be loaded. No data was changed.</p>
      <button type="button" disabled={pending} onClick={() => transition(() => router.refresh())}>
        {pending ? "Retrying…" : "Retry audit events"}
      </button>
    </CardBody></Card>
  </>;
}
