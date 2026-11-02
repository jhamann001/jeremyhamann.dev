import { SectionLabel } from "@/components/ui";

export function ComingSoon({ title, phase }: { title: string; phase?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        minHeight: "60vh",
        maxWidth: 520,
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <SectionLabel>Coming soon</SectionLabel>
      <h1>{title}</h1>
      {phase ? (
        <p className="muted" style={{ color: "var(--muted)", fontSize: 14 }}>
          Coming in {phase}
        </p>
      ) : null}
    </div>
  );
}
