import type { PillTone } from "@/components/ui";
import type { DealStage } from "@/lib/data/deal-types";

// DealStage → PillTone, the Phase C status-tone idiom (see
// components/workflow/status-tone.ts): one total map per vocabulary, screens
// call the helper instead of re-deriving tones inline. Pure (no React) —
// unit-tested in test/deal-stage-tone.test.ts. Labels live with the contract
// (`stageLabel` in lib/data/deal-types.ts), not here.

const STAGE: Record<DealStage, PillTone> = {
  POTENTIAL: "gold",
  COMMITTED: "blue",
  FUNDING: "amber",
  WON: "green",
  LOST: "red",
};

export const stageTone = (stage: DealStage): PillTone => STAGE[stage];
