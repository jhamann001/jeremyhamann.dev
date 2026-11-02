import Link from "next/link";
import { Button, Card, CardBody } from "@/components/ui";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";

export function TradeRequestsPermissionScreen() {
  return (
    <Card data-testid="trade-requests-permission">
      <CardBody>
        <p>{TRADE_REQUESTS_COPY.noPermission}</p>
        <Link href="/command-center" prefetch={false}><Button variant="primary">{TRADE_REQUESTS_COPY.goHome}</Button></Link>
      </CardBody>
    </Card>
  );
}

// Replaces a workspace view's content when the service cannot confirm the
// person or role. Never used for bell calls.
export function TradeRequestsNotSetUp() {
  return (
    <Card data-testid="trade-requests-not-set-up">
      <CardBody><p>{TRADE_REQUESTS_COPY.notSetUp}</p></CardBody>
    </Card>
  );
}
