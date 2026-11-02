import { cache } from "react";
import { fetchAcatList, AcatListError } from "@/lib/data/acat-status";
import {
  buildAcatChipMap,
  filterAcatChipMapForVisibleRows,
  type AcatChipMap,
} from "@/lib/data/acat-lane";
import type { TransferBoardClientRow } from "@/lib/data/transfer-board-client";
import { TransferBoard } from "./TransferBoard";

// Async SERVER component (transfer-centric board, step 1) — the tracker-hydrated
// board. It fetches the firm-wide ACAT list ONCE, reduces it to a per-ACAT chip
// map (buildAcatChipMap), filters that firm-wide map to the identifiers already
// present on the RLS-scoped `rows`, and renders <TransferBoard> WITH only those
// visible chips so each linked transfer card shows its live status chip. The
// full tracker identifier inventory never crosses into the browser props.
//
// SUSPENSE-DEFERRED (the PR #133 perf lesson, mirrored from AcatStatusSection /
// the old InTransferLane slot): the page renders this inside a <Suspense> whose
// FALLBACK is the plain <TransferBoard rows> (NO chips) — so the board shell +
// every transfer card paint INSTANTLY, and only the chips stream in when the
// external tracker resolves. `fetchAcatList()` NEVER blocks the board shell.
//
// GRACEFUL DEGRADE: an AcatListError (tracker 401/5xx/transport) is swallowed to
// an EMPTY chip map — the board renders with no chips, no error, no fabricated
// status (identical to the Suspense fallback). Any non-AcatListError is
// re-thrown (a real bug should surface, not be masked as "no chips").

// Request-level dedup only: cache() memoizes the list fetch for a SINGLE
// request. Not time-based — ACAT status is live.
const readAcatList = cache(() => fetchAcatList());

export async function AcatChipBoard({ rows }: { rows: TransferBoardClientRow[] }) {
  let chips: AcatChipMap = {};
  try {
    const firmWideChips = buildAcatChipMap(await readAcatList());
    chips = filterAcatChipMapForVisibleRows(firmWideChips, rows);
  } catch (err) {
    if (!(err instanceof AcatListError)) throw err; // unexpected → surface
    // Tracker unavailable → render the board with NO chips.
  }
  return <TransferBoard rows={rows} chips={chips} />;
}
