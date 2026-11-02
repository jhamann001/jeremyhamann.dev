"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, Card, CardBody } from "@/components/ui";
import { QUEUE_COPY } from "@/lib/trade-requests/queue-model";

export function TradeRequestsSessionEnded() {
  const path = usePathname() ?? "/trade-requests";
  return (
    <Card data-testid="trade-requests-session-ended">
      <CardBody>
        <p role="alert">{QUEUE_COPY.signedOut}</p>
        <Link href={`/?callbackUrl=${encodeURIComponent(path)}`} prefetch={false}><Button>{QUEUE_COPY.signIn}</Button></Link>
      </CardBody>
    </Card>
  );
}
