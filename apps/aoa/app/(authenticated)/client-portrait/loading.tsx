import { Card, SectionLabel } from "@/components/ui";

export default function LoadingClients() {
  return (
    <>
      <SectionLabel>Client · Portrait</SectionLabel>
      <h1 style={{ marginTop: 4 }}>Clients</h1>
      <Card style={{ marginTop: 18, padding: 24 }} aria-busy="true">
        <p style={{ margin: 0, color: "var(--muted)" }}>Loading clients…</p>
      </Card>
    </>
  );
}
