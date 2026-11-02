import type { ReactNode } from "react";
import { ClientHubTabs } from "@/components/client-portrait";

// Client-hub shell (Phase F / TDD ADR-1): the 4-tab bar above every hub route
// (Portrait · Dual-View · Illustration · Reminders). Deliberately THIN — no
// data reads, no auth: identity + RLS + notFound() live in each page (the
// shipped Portrait page already resolves the client via clientPortraitDetail;
// sub-tab pages own their own reads). The tab hrefs derive the client id
// client-side (useParams), so this layout needs nothing from `params` (ADR-2:
// the shipped Portrait page.tsx is untouched; this only prepends the bar).
export default function ClientHubLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ClientHubTabs />
      {children}
    </>
  );
}
