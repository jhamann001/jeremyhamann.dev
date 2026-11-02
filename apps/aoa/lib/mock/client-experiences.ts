import type { AllocationSlice } from "@/lib/client-experience";
import type { ClientAccounts, RiskProfile } from "@/lib/data/types";
import {
  accountsByClient,
  portraitByClient,
  riskByClient,
} from "@/lib/mock/client-portrait";

export type DualViewActivity = {
  time: string;
  text: string;
  source: string;
};

export type DualViewInsight = {
  tone: "opportunity" | "risk" | "context" | "healthy";
  title: string;
  body: string;
  status: string;
  provenance: string;
};

export type ClientExperienceFixture = {
  illustration: {
    allocation: AllocationSlice[];
    annualReturnPercent: number;
    years: number;
    fallbackStartingValue: number;
    modelNote: string;
  };
  dualView: {
    meetingLabel: string;
    tenure: string;
    brief: string;
    realTime: DualViewActivity[];
    historical: DualViewActivity[];
    insights: DualViewInsight[];
  };
};

export type ClientExperienceScenario = {
  id: string;
  label: string;
  description: string;
  fixture: ClientExperienceFixture;
  accounts: ClientAccounts;
  risk: RiskProfile;
  portrait: Record<string, string>;
};

const COLORS = {
  usEquity: "#2f5d4d",
  international: "#3a7560",
  fixedIncome: "#2c5f73",
  cash: "#b08a35",
  alternatives: "#6c6457",
} as const;

// Deliberately no `default` fixture. These experiences render only for known
// synthetic development clients; an unrecognized or real client gets an honest
// empty state instead of a plausible-looking invented story.
export const clientExperienceFixtures: Partial<
  Record<string, ClientExperienceFixture>
> = {
  "C-1": {
    illustration: {
      allocation: [
        { label: "US equity", percentage: 35, color: COLORS.usEquity },
        { label: "International equity", percentage: 15, color: COLORS.international },
        { label: "Fixed income", percentage: 38, color: COLORS.fixedIncome },
        { label: "Cash", percentage: 10, color: COLORS.cash },
        { label: "Alternatives", percentage: 2, color: COLORS.alternatives },
      ],
      annualReturnPercent: 5.5,
      years: 20,
      fallbackStartingValue: 2_450_000,
      modelNote: "Capital-preservation model with additional liquidity for planned distributions.",
    },
    dualView: {
      meetingLabel: "Quarterly review · sample agenda",
      tenure: "6 years",
      brief:
        "The sample scenario centers on distribution timing, trust administration, and a recently received wire. Lead with the known plan and show one recommended path before discussing alternatives.",
      realTime: [
        { time: "Today", text: "Asked about this year's distribution timing", source: "Synthetic email signal" },
        { time: "Yesterday", text: "$250,000 wire posted to the joint account", source: "Synthetic account event" },
        { time: "3 days", text: "Distribution paperwork moved to scheduled", source: "Synthetic workflow event" },
      ],
      historical: [
        { time: "Jun 2026", text: "Quarterly review focused on trust administration", source: "Synthetic meeting note" },
        { time: "2025", text: "Communication preference reconfirmed: phone first", source: "Synthetic client portrait" },
        { time: "2020", text: "Client relationship started", source: "Synthetic onboarding record" },
      ],
      insights: [
        { tone: "opportunity", title: "Sequence the distribution conversation", body: "Confirm the annual distribution amount before repositioning the new cash so both decisions use the same liquidity plan.", status: "Meeting priority", provenance: "Sample synthesis: prep fixture + account event" },
        { tone: "risk", title: "Trust details need confirmation", body: "The sample record still carries an open successor-trustee confirmation item.", status: "Open item", provenance: "Sample synthesis: meeting-prep fixture" },
        { tone: "context", title: "Lead with certainty", body: "The client profile indicates a preference for one clear recommendation and phone-based follow-up.", status: "Communication", provenance: "Sample synthesis: qualitative portrait" },
        { tone: "healthy", title: "Liquidity is available", body: "The recent sample wire creates room to fund planned distributions without forcing an immediate sale.", status: "On track", provenance: "Sample synthesis: account event" },
      ],
    },
  },
  "C-2": {
    illustration: {
      allocation: [
        { label: "US equity", percentage: 40, color: COLORS.usEquity },
        { label: "International equity", percentage: 15, color: COLORS.international },
        { label: "Fixed income", percentage: 35, color: COLORS.fixedIncome },
        { label: "Cash", percentage: 8, color: COLORS.cash },
        { label: "Alternatives", percentage: 2, color: COLORS.alternatives },
      ],
      annualReturnPercent: 5.25,
      years: 20,
      fallbackStartingValue: 1_100_000,
      modelNote: "Balanced sample model with additional stability for shared household distributions.",
    },
    dualView: {
      meetingLabel: "Household planning follow-up · sample agenda",
      tenure: "6 years",
      brief:
        "The sample scenario focuses on Jo's individual preferences within the shared Stone household plan. Confirm distribution priorities and beneficiary goals, then show how Jo's account fits alongside the broader trust strategy.",
      realTime: [
        { time: "Today", text: "Reviewed the sample household distribution summary", source: "Synthetic portal signal" },
        { time: "2 days", text: "Beneficiary confirmation request marked complete", source: "Synthetic workflow event" },
        { time: "1 week", text: "Phone follow-up preference reconfirmed", source: "Synthetic client-profile event" },
      ],
      historical: [
        { time: "Jun 2026", text: "Household review separated Jo's goals from the trust agenda", source: "Synthetic meeting note" },
        { time: "2024", text: "Income and liquidity preferences updated", source: "Synthetic planning record" },
        { time: "2020", text: "Added to the Stone household relationship", source: "Synthetic onboarding record" },
      ],
      insights: [
        {
          tone: "opportunity",
          title: "Give Jo an individual view",
          body: "Open with Jo's allocation and distribution preferences before returning to the combined household plan.",
          status: "Meeting priority",
          provenance: "Sample synthesis: household note + client portrait",
        },
        {
          tone: "context",
          title: "Keep the household connection visible",
          body: "Jo's sample decisions affect the same liquidity plan as the Stone Family Trust, so show both the individual and shared implications.",
          status: "Household context",
          provenance: "Sample synthesis: household fixture + account state",
        },
        {
          tone: "healthy",
          title: "Beneficiary review is complete",
          body: "The sample workflow shows Jo's latest beneficiary confirmation as completed.",
          status: "On track",
          provenance: "Sample synthesis: workflow fixture",
        },
      ],
    },
  },
  "C-3": {
    illustration: {
      allocation: [
        { label: "US equity", percentage: 48, color: COLORS.usEquity },
        { label: "International equity", percentage: 18, color: COLORS.international },
        { label: "Fixed income", percentage: 25, color: COLORS.fixedIncome },
        { label: "Cash", percentage: 7, color: COLORS.cash },
        { label: "Alternatives", percentage: 2, color: COLORS.alternatives },
      ],
      annualReturnPercent: 6,
      years: 25,
      fallbackStartingValue: 1_180_000,
      modelNote: "Balanced-growth sample model for a newly funded household.",
    },
    dualView: {
      meetingLabel: "Plan presentation · sample agenda",
      tenure: "2 years",
      brief: "The sample scenario is ready for a concise plan presentation. Confirm that funding has landed, show the target allocation, and close with the held-away-account connection step.",
      realTime: [
        { time: "Today", text: "Risk questionnaire marked complete", source: "Synthetic intake event" },
        { time: "2 days", text: "Brokerage remains in funding status", source: "Synthetic account event" },
        { time: "1 week", text: "Financial-plan draft shared for review", source: "Synthetic workflow event" },
      ],
      historical: [
        { time: "May 2026", text: "Financial-plan draft reviewed", source: "Synthetic meeting note" },
        { time: "2025", text: "Initial discovery and risk assessment completed", source: "Synthetic intake record" },
      ],
      insights: [
        { tone: "opportunity", title: "Turn the plan into a visual decision", body: "Use the allocation illustration to connect the completed risk questionnaire to a concrete target model.", status: "Ready to present", provenance: "Sample synthesis: risk fixture + account state" },
        { tone: "risk", title: "Funding is not fully settled", body: "Keep implementation language conditional until the sample brokerage account leaves funding status.", status: "Watch", provenance: "Sample synthesis: account fixture" },
        { tone: "context", title: "One remaining data gap", body: "Held-away accounts are not linked in this sample, so net worth is incomplete.", status: "Data gap", provenance: "Sample synthesis: Plaid fixture" },
      ],
    },
  },
  "C-4": {
    illustration: {
      allocation: [
        { label: "US equity", percentage: 55, color: COLORS.usEquity },
        { label: "International equity", percentage: 20, color: COLORS.international },
        { label: "Fixed income", percentage: 15, color: COLORS.fixedIncome },
        { label: "Cash", percentage: 5, color: COLORS.cash },
        { label: "Alternatives", percentage: 5, color: COLORS.alternatives },
      ],
      annualReturnPercent: 6.5,
      years: 25,
      fallbackStartingValue: 875_000,
      modelNote: "Growth-oriented sample model with a dedicated business-liquidity reserve.",
    },
    dualView: {
      meetingLabel: "Onboarding follow-up · sample agenda",
      tenure: "New relationship",
      brief: "The sample scenario is still in onboarding. Focus the conversation on funding, beneficiary completion, and setting the first realized-gains budget before moving into implementation.",
      realTime: [
        { time: "Today", text: "Business checking connection remains active", source: "Synthetic connection event" },
        { time: "8 days", text: "Proposal remains open", source: "Synthetic engagement signal" },
        { time: "2 weeks", text: "SEP IRA account activated", source: "Synthetic account event" },
      ],
      historical: [
        { time: "Jun 2026", text: "Onboarding meeting completed", source: "Synthetic meeting note" },
        { time: "May 2026", text: "Business-owner discovery captured", source: "Synthetic intake record" },
      ],
      insights: [
        { tone: "opportunity", title: "Set the tax-budget guardrail", body: "The sample household has no current realized-gains budget, so establish it before illustrating taxable implementation choices.", status: "Advisor action", provenance: "Sample synthesis: tax-budget state" },
        { tone: "risk", title: "Proposal engagement is stale", body: "The sample proposal has remained open for eight days without a completed next step.", status: "Follow up", provenance: "Sample synthesis: engagement fixture" },
        { tone: "healthy", title: "Business liquidity is visible", body: "The connected sample checking balance can support a clearer separation between operating cash and long-term assets.", status: "Useful context", provenance: "Sample synthesis: external-account fixture" },
      ],
    },
  },
  "C-5": {
    illustration: {
      allocation: [
        { label: "US equity", percentage: 45, color: COLORS.usEquity },
        { label: "International equity", percentage: 18, color: COLORS.international },
        { label: "Fixed income", percentage: 25, color: COLORS.fixedIncome },
        { label: "Cash", percentage: 7, color: COLORS.cash },
        { label: "Alternatives", percentage: 5, color: COLORS.alternatives },
      ],
      annualReturnPercent: 6,
      years: 18,
      fallbackStartingValue: 3_320_000,
      modelNote: "Moderate-growth sample model balancing legacy goals and near-term flexibility.",
    },
    dualView: {
      meetingLabel: "Annual strategy review · sample agenda",
      tenure: "8 years",
      brief: "The sample scenario has broad account coverage and a mature relationship history. Lead with the decision that matters now, then use the net-worth view to show how managed and held-away assets work together.",
      realTime: [
        { time: "Today", text: "Held-away retirement balance refreshed", source: "Synthetic connection event" },
        { time: "2 days", text: "Annual review agenda opened", source: "Synthetic portal event" },
        { time: "1 week", text: "Beneficiary review task completed", source: "Synthetic workflow event" },
      ],
      historical: [
        { time: "2025", text: "Legacy priorities and gifting plan reconfirmed", source: "Synthetic meeting note" },
        { time: "2023", text: "Target allocation moved to moderate growth", source: "Synthetic decision record" },
        { time: "2018", text: "Client relationship started", source: "Synthetic onboarding record" },
      ],
      insights: [
        { tone: "opportunity", title: "Show the complete balance sheet", body: "This sample includes both managed and held-away assets, making the net-worth illustration the clearest opening visual.", status: "Recommended view", provenance: "Sample synthesis: account fixtures" },
        { tone: "context", title: "Connect allocation to legacy goals", body: "Frame growth assumptions around the household's long-term gifting plan, not market forecasts.", status: "Planning context", provenance: "Sample synthesis: portrait fixture" },
        { tone: "healthy", title: "Beneficiary review is current", body: "The sample workflow shows the latest beneficiary review as complete.", status: "On track", provenance: "Sample synthesis: workflow fixture" },
      ],
    },
  },
  "C-6": {
    illustration: {
      allocation: [
        { label: "US equity", percentage: 50, color: COLORS.usEquity },
        { label: "International equity", percentage: 20, color: COLORS.international },
        { label: "Fixed income", percentage: 20, color: COLORS.fixedIncome },
        { label: "Cash", percentage: 5, color: COLORS.cash },
        { label: "Alternatives", percentage: 5, color: COLORS.alternatives },
      ],
      annualReturnPercent: 6.25,
      years: 22,
      fallbackStartingValue: 1_540_000,
      modelNote: "Growth sample model with room for future held-away assets.",
    },
    dualView: {
      meetingLabel: "Planning review · sample agenda",
      tenure: "4 years",
      brief: "The sample scenario has a clear managed-account picture but no connected external accounts. Use allocation and growth illustrations while explicitly identifying the missing held-away view.",
      realTime: [
        { time: "Today", text: "Planning review scheduled", source: "Synthetic calendar event" },
        { time: "3 days", text: "Traditional IRA balance refreshed", source: "Synthetic account event" },
        { time: "1 week", text: "External-account connection reminder sent", source: "Synthetic workflow event" },
      ],
      historical: [
        { time: "2025", text: "Long-term growth goal reconfirmed", source: "Synthetic meeting note" },
        { time: "2022", text: "Client relationship started", source: "Synthetic onboarding record" },
      ],
      insights: [
        { tone: "opportunity", title: "Validate the growth assumptions", body: "Use the editable projection to agree on a planning range rather than presenting one return as an expected outcome.", status: "Meeting priority", provenance: "Sample synthesis: planning fixture" },
        { tone: "risk", title: "Net worth is incomplete", body: "No held-away accounts are connected in this sample; do not describe the managed-account total as household net worth.", status: "Data gap", provenance: "Sample synthesis: connection state" },
        { tone: "context", title: "Keep the visual focused", body: "The sample profile favors a direct presentation with fewer scenarios and explicit assumptions.", status: "Communication", provenance: "Sample synthesis: portrait fixture" },
      ],
    },
  },
};

const DEVELOPMENT_SCENARIOS = [
  {
    fixtureId: "C-1",
    id: "distribution",
    label: "Distribution planning",
    description: "Trust administration, liquidity, and a planned distribution.",
  },
  {
    fixtureId: "C-3",
    id: "newly-funded",
    label: "Newly funded plan",
    description: "A recently funded household moving from discovery to implementation.",
  },
  {
    fixtureId: "C-4",
    id: "business-owner",
    label: "Business owner",
    description: "Business liquidity, taxable implementation, and an open proposal.",
  },
  {
    fixtureId: "C-5",
    id: "legacy",
    label: "Legacy planning",
    description: "A mature relationship with managed and held-away assets.",
  },
  {
    fixtureId: "C-6",
    id: "growth",
    label: "Growth planning",
    description: "Long-term growth assumptions with an incomplete external picture.",
  },
] as const;

/**
 * Development-only preview stories. These are deliberately independent from
 * the selected CRM client: the client supplies only the page shell/name, while
 * every activity, balance, risk value, and planning detail below is synthetic.
 */
export function developmentClientExperienceScenarios(): ClientExperienceScenario[] {
  return DEVELOPMENT_SCENARIOS.map((scenario) => {
    const fixture = clientExperienceFixtures[scenario.fixtureId];
    if (!fixture) {
      throw new Error(`Missing development client-experience fixture: ${scenario.fixtureId}`);
    }
    return {
      id: scenario.id,
      label: scenario.label,
      description: scenario.description,
      fixture,
      accounts: accountsByClient[scenario.fixtureId] ?? accountsByClient.default,
      risk: riskByClient[scenario.fixtureId] ?? riskByClient.default,
      portrait: portraitByClient[scenario.fixtureId] ?? portraitByClient.default,
    };
  });
}

export function initialDevelopmentScenarioId(clientId: string): string {
  const hash = Array.from(clientId).reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return DEVELOPMENT_SCENARIOS[hash % DEVELOPMENT_SCENARIOS.length].id;
}
