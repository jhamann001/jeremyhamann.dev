import { Pill, type PillTone } from "@/components/ui";
import type { AcatChip, AcatToneKind } from "@/lib/data/acat-lane";
import { resolveAcatStatus } from "@/lib/data/acat-status-catalog";
import styles from "./AcatStatusChip.module.css";

// Compact, at-a-glance ACAT status chip for a TransferCard (transfer-centric
// board, step 1). An ACAT is an ATTRIBUTE of a transfer (1:1 via
// acat_transfer_id) — this chip is the card's live indicator; the full ACAT
// detail (positions, masked numbers, reconciliation) lives on the transfer
// detail page, which the card already deep-links to. Purely presentational: the
// chip data (status/tone/needsAttention) is built server-side in
// lib/data/acat-lane.ts (`buildAcatChipMap`) and looked up per card.
//
// TONE: reuses the ACAT status vocabulary (acatToneKind → green/amber/red/gray)
// so it matches the detail page's AcatStatusCard. ATTENTION: when the ACAT is
// rejected OR has a position mismatch (chip.needsAttention), the chip forces the
// red/danger treatment with a dot — regardless of the base status tone (e.g. an
// Accepted ACAT with an unmapped position still flags red).

// status tone → Pill tone: accepted → green, submitted/pending → amber,
// rejected → red, neutral → gray.
const TONE: Record<AcatToneKind, PillTone> = {
  accepted: "green",
  submitted: "amber",
  rejected: "red",
  neutral: "gray",
};

export function AcatStatusChip({ chip }: { chip: AcatChip }) {
  const tone: PillTone = chip.needsAttention ? "red" : TONE[chip.tone];
  // Friendly display label from the canonical catalog (ticket) so the chip
  // reads "Pending Settlement", not the raw "PendingSettlement". Tone stays as
  // built server-side (chip.tone + the needsAttention override).
  const label = resolveAcatStatus(chip.status).label;
  return (
    <span
      className={styles.chip}
      title={
        chip.needsAttention
          ? `ACAT: ${label} · needs attention`
          : `ACAT: ${label}`
      }
    >
      <span className={styles.label}>ACAT</span>
      <Pill tone={tone} dot={chip.needsAttention}>
        {label}
      </Pill>
    </span>
  );
}
