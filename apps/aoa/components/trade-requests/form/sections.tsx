import type { ComponentType } from "react";
import { NEW_REQUEST_COPY, hasAccountSelection, type NewRequestDraft } from "@/lib/trade-requests/new-request";
import {
  ALLOCATION_COPY,
  previousAllocationLoading,
  previousAllocationPromptVisible,
} from "@/lib/trade-requests/new-request-allocation";
import { TRADE_TYPE_COPY, fullFormSectionsVisible } from "@/lib/trade-requests/new-request-trade-types";
import { EquityStrategySection } from "./allocation/EquityStrategySection";
import { MandateSection } from "./allocation/MandateSection";
import { PriorAllocationPrompt } from "./allocation/PriorAllocationPrompt";
import { ClientAccountSection } from "./ClientAccountSection";
import { ComplianceSection } from "./common-inputs/ComplianceSection";
import { NotesSection } from "./common-inputs/NotesSection";
import type { NewRequestSectionProps } from "./FormSectionHeading";
import { CashRaiseSection } from "./trade-types/CashRaiseSection";
import { DepositSection } from "./trade-types/DepositSection";
import { LiquidationSection } from "./trade-types/LiquidationSection";
import { NewDepositsSection } from "./trade-types/NewDepositsSection";

export type NewRequestSection = {
  id: string;
  owner: string;
  title: string;
  visible: (draft: NewRequestDraft) => boolean;
  Component: ComponentType<NewRequestSectionProps>;
  /** Not counted when numbering (the previous-allocation prompt). */
  unnumbered?: boolean;
};

const tradeTypeSection = (tradeType: NewRequestDraft["tradeType"]) => (draft: NewRequestDraft) =>
  draft.tradeType === tradeType && hasAccountSelection(draft);

/**
 * Form sections in display order. Numbers are assigned among the visible
 * sections, so they adapt to the trade type. Each form work order appends its
 * own sections; the shell renders whatever is registered. The allocation
 * sections go between the trade-type sections and "compliance".
 */
export const NEW_REQUEST_SECTIONS: readonly NewRequestSection[] = [
  { id: "client-account", owner: "TRW-11", title: NEW_REQUEST_COPY.clientContext, visible: () => true, Component: ClientAccountSection },
  { id: "cash-raise", owner: "TRW-13", title: TRADE_TYPE_COPY.cashRaiseDetails, visible: tradeTypeSection("Raise Cash"), Component: CashRaiseSection },
  { id: "liquidation", owner: "TRW-13", title: TRADE_TYPE_COPY.liquidationDetails, visible: tradeTypeSection("Liquidate"), Component: LiquidationSection },
  { id: "deposit", owner: "TRW-13", title: TRADE_TYPE_COPY.depositDetails, visible: tradeTypeSection("Cash Deposit"), Component: DepositSection },
  { id: "new-deposits", owner: "TRW-13", title: TRADE_TYPE_COPY.newDeposits, visible: tradeTypeSection("Rebalance"), Component: NewDepositsSection },
  {
    id: "previous-allocation", owner: "TRW-14", title: ALLOCATION_COPY.priorOnFile, unnumbered: true,
    visible: (draft) => previousAllocationLoading(draft) || previousAllocationPromptVisible(draft), Component: PriorAllocationPrompt,
  },
  { id: "mandate", owner: "TRW-14", title: ALLOCATION_COPY.mandate, visible: fullFormSectionsVisible, Component: MandateSection },
  { id: "equity-strategy", owner: "TRW-14", title: ALLOCATION_COPY.equityStrategy, visible: fullFormSectionsVisible, Component: EquityStrategySection },
  { id: "compliance", owner: "TRW-13", title: TRADE_TYPE_COPY.compliance, visible: fullFormSectionsVisible, Component: ComplianceSection },
  { id: "notes", owner: "TRW-13", title: TRADE_TYPE_COPY.notes, visible: () => true, Component: NotesSection },
];

export function visibleSections(draft: NewRequestDraft, sections: readonly NewRequestSection[] = NEW_REQUEST_SECTIONS) {
  let number = 0;
  return sections.filter((section) => section.visible(draft)).map((section) => ({ section, number: section.unnumbered ? 0 : ++number }));
}
