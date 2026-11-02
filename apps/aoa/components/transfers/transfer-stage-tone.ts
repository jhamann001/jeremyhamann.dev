import type { PillTone } from "@/components/ui";
import type { TransferStage } from "@/lib/data/transfer-types";

// TransferStage → PillTone, the Phase C status-tone idiom (see
// components/deals/stage-tone.ts): one total map per vocabulary, screens call
// the helper instead of re-deriving tones inline. Tones follow the mockup's
// STAGE_TEXT/STAGE_COLORS (green / gold / blue / blue / green). Pure (no
// React) — unit-tested in test/transfer-stage-tone.test.ts. Labels live with
// the contract (`stageLabel` in lib/data/transfer-types.ts), not here.

const STAGE: Record<TransferStage, PillTone> = {
  DECISION: "gold",
  IN_TRANSFER: "blue",
  FUNDED: "green",
};

export const transferStageTone = (stage: TransferStage): PillTone =>
  STAGE[stage];
