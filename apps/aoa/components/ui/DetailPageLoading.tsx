import { Card, Kpi, SectionLabel } from "@/components/ui";

export function DetailPageLoading({
  section,
  title,
}: {
  section: string;
  title: string;
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <SectionLabel>{section}</SectionLabel>
      <h1 style={{ marginTop: 4 }}>{title}</h1>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
          marginTop: 18,
        }}
      >
        <Card><Kpi label="Loading current data" value="…" /></Card>
        <Card><Kpi label="Preparing details" value="…" /></Card>
      </div>
      <Card style={{ marginTop: 24, minHeight: 220 }}>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          Loading the latest available information…
        </p>
      </Card>
    </div>
  );
}
