import { Card } from "@/components/ui";

/** Default for routes without a more specific skeleton; keep the shell usable. */
export default function AuthenticatedPageLoading() {
  return (
    <Card style={{ padding: 24 }} aria-busy="true">
      <p role="status" style={{ margin: 0, color: "var(--muted)" }}>Loading page…</p>
    </Card>
  );
}
