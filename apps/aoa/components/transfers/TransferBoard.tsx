"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { TransferBoardClientRow } from "@/lib/data/transfer-board-client";
import type { AcatChipMap } from "@/lib/data/acat-lane";
// isFallenOff comes from the PURE transfer-types module — NOT @/lib/data/transfers
// (that seam value-imports Prisma; pulling it into this "use client" component would
// drag Prisma into the client bundle and break the build). See ticket §2.
import { STAGE_ORDER, isFallenOff } from "@/lib/data/transfer-types";
import { TransferLane } from "./TransferLane";
import styles from "./TransferBoard.module.css";

// The three-lane lifecycle board (TDD §6, WO ticket). "use client" over
// seam-serialized rows (every numeric already Number()-coerced — the Decimal
// trap stops at lib/data/transfers.ts). Lanes render unconditionally in
// STAGE_ORDER — the empty-board state is three zero-count lanes, never a
// blank. No drag-and-drop: stage changes are the detail route's audited
// controls (T3); the board carries NO PreviewBadge — real rows, real writes
// domain.
//
// TRANSFER-CENTRIC (step 1, owner decision 2026-07-15): every lane — In
// Transfer included — renders through the normal <TransferLane>/<TransferCard>
// path. There is no special In Transfer column and no folded ACAT cards
// (reverses #140/#142 at the display level). An ACAT is surfaced as a chip on
// its linked transfer card. `chips` (link id → chip, keyed by both the tracker
// record id and the real UUID — buildAcatChipMap) is OPTIONAL and
// fetched non-blockingly by the page (Suspense-deferred): the board shell +
// cards paint instantly WITHOUT chips (the fallback passes none), and the chips
// stream in when the external tracker resolves. Every lane receives the same
// map, already filtered server-side to the IDs carried by `rows` — a linked
// transfer shows its chip in ANY stage, not only In Transfer.
export function TransferBoard({
  rows,
  chips,
}: {
  rows: TransferBoardClientRow[];
  chips?: AcatChipMap;
}) {
  // "Show completed" toggle (ticket → router-tracked in ticket). Fallen-off FUNDED
  // transfers are hidden from the lanes by default; the toggle re-includes them. The state
  // is DERIVED from the `?completed=1` router param (no local useState / no
  // window.location seeding): the toggle now persists via `router.replace`, which the App
  // Router tracks, so `useSearchParams()` observes it — both Suspense instances read the
  // same param (no divergence / no hydration flash) and browser Back/Forward restores it.
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const showCompleted = params.get("completed") === "1";
  // Focus reveals completed (ticket §0.5): when a client/household focus is active
  // (?household / ?q), show the whole book — including fallen-off FUNDED cards — so a
  // focused household surfaces its completed transfers and the banner count matches the
  // visible cards. The "Show completed" checkbox is unchanged; focus just overrides the
  // hide.
  // Match page.tsx's param coercion: a single-valued ?household/?q counts as a focus; a
  // repeated (array) param is ignored, so the board never diverges from the server filter.
  const singleParam = (k: string) => {
    const all = params.getAll(k);
    return all.length === 1 ? all[0] : "";
  };
  const focusActive = !!(singleParam("household") || singleParam("q"));
  const showAll = showCompleted || focusActive;
  const hiddenCount = rows.filter(isFallenOff).length;
  const visible = showAll ? rows : rows.filter((r) => !isFallenOff(r));

  return (
    <>
      <div className={styles.boardHead}>
        <label className={styles.showCompleted}>
          <input
            type="checkbox"
            checked={showAll}
            disabled={focusActive}
            title={
              focusActive
                ? "Completed shown while filtering a client or household"
                : undefined
            }
            onChange={(e) => {
              const sp = new URLSearchParams(params.toString());
              if (e.target.checked) sp.set("completed", "1");
              else sp.delete("completed");
              const qs = sp.toString();
              router.replace(qs ? `${pathname}?${qs}` : pathname, {
                scroll: false,
              });
            }}
          />
          Show completed{hiddenCount ? ` (${hiddenCount})` : ""}
        </label>
      </div>
      <div className={styles.lanes}>
        {STAGE_ORDER.map((stage) => (
          <TransferLane
            key={stage}
            stage={stage}
            rows={visible.filter((r) => r.stage === stage)}
            chips={chips}
          />
        ))}
      </div>
    </>
  );
}
