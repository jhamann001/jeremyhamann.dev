import { ComingSoon } from "@/components/ComingSoon";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { clientPortraitDetail } from "@/lib/data/portrait";
import { clientPortraitExperimentsEnabled } from "@/lib/flags";
import {
  developmentClientExperienceScenarios,
  initialDevelopmentScenarioId,
} from "@/lib/mock/client-experiences";
import { DualViewExperience } from "@/components/client-portrait/DualViewExperience";
import { ClientExperienceEmpty } from "@/components/client-portrait/ClientExperienceEmpty";
import { demoMode } from "@/lib/demo/mode";
import { demoDualViewScenario, demoShowcaseClients } from "@/lib/demo/samples/clients";
import { getClientWithHousehold } from "@/lib/data/clients";

// The full surface is deliberately development-only while its signal and AI
// seams are validated. Production keeps the honest Phase E placeholder. The
// public demo shows it with the sample stories written for its showcase clients
// (lib/demo/samples), labeled as samples, and points every other client to them.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const demo = demoMode();
  if (!demo && !clientPortraitExperimentsEnabled()) {
    return <ComingSoon title="Dual-View" phase="Phase E" />;
  }

  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
  const detail = await clientPortraitDetail(identity, id);
  if (!detail) notFound();

  if (demo) {
    const story = demoDualViewScenario(detail.client.sf_id);
    if (story) {
      return <DualViewExperience clientName={detail.client.name} scenarios={[story]} initialScenarioId={story.id} clientStory />;
    }
    // Offer only the showcase clients this visitor's role can open (an advisor sees their own book).
    const showcase = demoShowcaseClients();
    const visible = await Promise.all(showcase.map((c) => getClientWithHousehold(identity, c.id)));
    return (
      <ClientExperienceEmpty
        clientId={detail.client.sf_id}
        clientName={detail.client.name}
        title="Dual-View"
        showcase={showcase.filter((_, i) => visible[i])}
      />
    );
  }

  return (
    <DualViewExperience
      clientName={detail.client.name}
      scenarios={developmentClientExperienceScenarios()}
      initialScenarioId={initialDevelopmentScenarioId(detail.client.sf_id)}
    />
  );
}
