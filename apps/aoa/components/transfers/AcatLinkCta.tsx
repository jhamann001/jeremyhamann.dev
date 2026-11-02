import { Card, CardBody } from "@/components/ui";
import { TransferAcatPicker } from "./TransferAcatPicker";

// The page gates this firm-wide picker to Ops/Admin, for an open, unlinked
// transfer. The inline funding-picture entry point uses the same picker.

export function AcatLinkCta({ transferId }: { transferId: string }) {
  return (
    <Card>
      <CardBody
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 240px" }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>
            No live ACAT linked
          </p>
          <p
            style={{
              margin: "4px 0 0",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            Find an existing tracker ACAT and review it before linking live
            status to this transfer.
          </p>
        </div>
        <TransferAcatPicker transferId={transferId} />
      </CardBody>
    </Card>
  );
}
