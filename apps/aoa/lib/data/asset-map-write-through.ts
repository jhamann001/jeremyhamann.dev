import "server-only";
import type { Prisma } from "@prisma/client";
import { withIngestScope } from "@/lib/ingest/scope";
import type { AssetMapPositionStatus, AssetMapTransferringValue } from "@/lib/data/asset-map";

// Ruling A (ticket): after the pipeline (the system of record) confirms a
// save, the same server action writes the confirmed value into the mirror so
// a reload shows it; the hourly pull writes the same value later. The mirror
// RLS gives app_rw SELECT only, so this runs on the ingest_rw connection, the
// one the asset-map cron uses. Ids and enums only; never logs a value.

export type AssetMapConfirmedEdit =
  | { kind: "positionStatus"; positionId: string; status: AssetMapPositionStatus; notes: string }
  | { kind: "positionTransferring"; positionId: string; value: AssetMapTransferringValue }
  | {
      kind: "accountType"; accountId: string; accountType: string; accountTypeOther: string | null;
      isRollover?: boolean; isInherited?: boolean; apexRestriction?: string | null;
      overriddenBy?: string | null; overriddenAt?: string;
    }
  | { kind: "removePosition" | "restorePosition"; positionId: string }
  | { kind: "removeAccount" | "restoreAccount"; accountId: string };

const TRANSFERRING: Record<"YES" | "NO", boolean> = { YES: true, NO: false };

export async function applyAssetMapWriteThrough(tx: Prisma.TransactionClient, e: AssetMapConfirmedEdit): Promise<void> {
  switch (e.kind) {
    case "positionStatus":
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_position
        SET override_status = ${e.status}, override_notes = ${e.notes},
            effective_status = ${e.status}, effective_notes = ${e.notes}
        WHERE id = ${e.positionId}`;
      return;
    case "positionTransferring":
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_position
        SET transferring = ${e.value === null ? null : TRANSFERRING[e.value]}
        WHERE id = ${e.positionId}`;
      return;
    case "accountType":
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_account
        SET account_type = ${e.accountType}, account_type_other = ${e.accountTypeOther},
            is_rollover = COALESCE(${e.isRollover ?? null}::boolean, is_rollover),
            is_inherited = COALESCE(${e.isInherited ?? null}::boolean, is_inherited),
            apex_restriction = CASE WHEN ${e.apexRestriction !== undefined} THEN ${e.apexRestriction ?? null} ELSE apex_restriction END,
            account_type_overridden_by = CASE WHEN ${e.overriddenAt !== undefined} THEN ${e.overriddenBy ?? null} ELSE account_type_overridden_by END,
            account_type_overridden_at = COALESCE(${e.overriddenAt ?? null}::timestamptz, account_type_overridden_at)
        WHERE id = ${e.accountId}`;
      return;
    case "removePosition":
    case "restorePosition":
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_position SET is_deleted = ${e.kind === "removePosition"}
        WHERE id = ${e.positionId}`;
      return;
    case "removeAccount":
    case "restoreAccount": {
      const deleted = e.kind === "removeAccount";
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_account SET is_deleted = ${deleted} WHERE id = ${e.accountId}`;
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_position SET is_deleted = ${deleted} WHERE account_id = ${e.accountId}`;
      return;
    }
  }
}

/** One ingest transaction. Never throws: the pipeline already holds the saved
 *  value, the in-session overlay shows it, and the next pull writes it. */
export async function writeThroughAssetMapEdit(edit: AssetMapConfirmedEdit): Promise<boolean> {
  try {
    await withIngestScope((tx) => applyAssetMapWriteThrough(tx, edit), { timeout: 10_000 });
    return true;
  } catch {
    console.error("[asset-map] write_through_failed");
    return false;
  }
}
