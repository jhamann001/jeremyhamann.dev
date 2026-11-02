import { permanentRedirect } from "next/navigation";

// Illustration is retired in every environment. Resolve identity and access in
// the destination Portrait page; never fetch the retired experience first.
export default async function Page({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    // A stale financial/subtab value must not override the Portrait fallback.
    if (key === "portraitTab" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  query.set("portraitTab", "comms");
  permanentRedirect(`/client-portrait/${encodeURIComponent(id)}?${query}`);
}
