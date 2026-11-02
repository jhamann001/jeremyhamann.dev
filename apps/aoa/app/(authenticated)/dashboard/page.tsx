import { redirect } from "next/navigation";

// Back-compat: Households moved to /households (B2). Old /dashboard bookmarks and
// links land here and redirect. (The sidebar count badge is keyed on /households in
// layout.tsx — it does not depend on this route.)
export default function Dashboard() {
  redirect("/households");
}
