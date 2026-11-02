import { Card, CardBody, CardHeader } from "@/components/ui";
import { getCrmRelationshipWorkspace } from "@/lib/data/crm-relationship-workspace";
import type { CrmRelationshipTraversalFailureReason } from "@/lib/data/crm-relationships";
import type { Identity } from "@/lib/rls";
import { RelationshipWorkspaceView } from "./RelationshipGraph";
import styles from "./CrmPreview.module.css";

function safeFailureMessage(reason: CrmRelationshipTraversalFailureReason): string {
  if (reason === "row_limit_exceeded") {
    return "This record has more connections than the map can safely display. Open it in CRM Explorer to review the direct connections.";
  }
  if (reason === "disabled") {
    return "The relationship map is currently unavailable.";
  }
  return "No active relationship record is available for this CRM ID.";
}

export async function RelationshipWorkspace({
  identity,
  rootIdentityId,
  compact = false,
}: {
  identity: Identity;
  rootIdentityId: string;
  compact?: boolean;
}) {
  const result = await getCrmRelationshipWorkspace(identity, rootIdentityId);
  if (!result.ok) {
    return (
      <Card>
        <CardHeader><h2>Relationships</h2></CardHeader>
        <CardBody><p className={styles.muted}>{safeFailureMessage(result.reason)}</p></CardBody>
      </Card>
    );
  }
  return <RelationshipWorkspaceView data={result.data} compact={compact} />;
}
