import { Button, Card, CardBody } from "@/components/ui";
import { COPY } from "./workspace-model";

export function ConnectionErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <CardBody>
        <h2>{COPY.connectionError}</h2>
        <Button onClick={onRetry}>{COPY.tryAgain}</Button>
      </CardBody>
    </Card>
  );
}
