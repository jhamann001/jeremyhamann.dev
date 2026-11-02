import { Card, SectionLabel } from "@/components/ui";

export default function LoadingHouseholds() {
  return (
    <>
      <SectionLabel>Firm · Directory</SectionLabel>
      <h1 style={{ marginTop: 4 }}>Households</h1>
      <Card style={{ marginTop: 18, padding: 24 }} aria-busy="true">
        <p style={{ margin: 0, color: "var(--muted)" }}>Loading households…</p>
      </Card>
    </>
  );
}
