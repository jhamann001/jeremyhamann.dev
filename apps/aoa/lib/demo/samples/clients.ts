// The demo's per-client sample data at run time (data/clients.json, written by build.ts): what the Client Portrait's
// fixture-backed sections show for a demo client, and the Dual-View story a showcase client has, dated from the
// seed's clock (clock.ts). Server only: the file holds every client's sample.

import "server-only";
import type { Beneficiary, MeetingPrep, RiskProfile } from "@/lib/data/types";
import type { ClientExperienceScenario } from "@/lib/mock/client-experiences";
import { lastDemoSampleNow } from "./clock";
import data from "./data/clients.json";
import { sampleLongDate, sampleWhen } from "./dates";
import type { DemoSamples } from "./types";

const SAMPLES = data as unknown as DemoSamples;

export interface DemoClientSample {
  bene: Beneficiary[];
  portrait: Record<string, string>;
  prep: MeetingPrep | null;
  risk: RiskProfile;
}

const riskOf = (score: number, tolerance: string): RiskProfile => ({ score, tolerance, capacity: "Not on file", change: "No change" });

/** The sample sections for a demo client, or null for an id the demo did not seed. `now` is the seed's clock
 *  (demoSampleNow). */
export function demoClientSample(sfId: string, now = lastDemoSampleNow()): DemoClientSample | null {
  const sample = SAMPLES.clients[sfId];
  if (!sample) return null;
  const prep = sample.prep;
  return {
    bene: sample.bene,
    portrait: sample.portrait,
    risk: riskOf(sample.risk.score, sample.risk.tolerance),
    prep: prep
      ? {
          advisor: prep.advisor,
          aum: prep.aum,
          tenure: prep.tenure,
          riskProfile: prep.riskProfile,
          lastMeeting: `${sampleLongDate(prep.lastMeeting.daysAgo, now)} — ${prep.lastMeeting.label}`,
          recentSignals: prep.recentSignals,
          openItems: prep.openItems,
          talkingPoints: prep.talkingPoints,
          notes: prep.notes,
        }
      : null,
  };
}

/** The showcase clients, whose every section is written: the Dual-View page points other clients to them. */
export const demoShowcaseClients = (): Array<{ id: string; name: string }> => SAMPLES.showcase;

/** A showcase client's Dual-View story in the shape the Dual-View page renders, or null. Dated from the seed's clock
 *  as the portrait read just before it last read it. */
export function demoDualViewScenario(sfId: string, now = lastDemoSampleNow()): ClientExperienceScenario | null {
  const sample = SAMPLES.clients[sfId];
  const story = sample?.dualView;
  if (!sample || !story) return null;
  return {
    id: `demo-${sfId}`,
    label: story.label,
    description: story.description,
    fixture: {
      // Dual-View does not draw the illustration; the scenario shape carries one for the retired Illustration tab.
      illustration: { allocation: [], annualReturnPercent: 0, years: 0, fallbackStartingValue: 0, modelNote: "" },
      dualView: {
        meetingLabel: story.meetingLabel,
        tenure: story.tenure,
        brief: story.brief,
        realTime: story.realTime.map((m) => ({ time: sampleWhen(m.daysAgo, now), text: m.text, source: m.source })),
        historical: story.historical.map((m) => ({ time: sampleWhen(m.daysAgo, now), text: m.text, source: m.source })),
        insights: story.insights,
      },
    },
    accounts: { apex: [], ext: [], bene: sample.bene, plaidLinked: false },
    risk: riskOf(sample.risk.score, sample.risk.tolerance),
    portrait: sample.portrait,
  };
}
