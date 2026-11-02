import { STAGE_ORDER, type TransferStage } from "./transfer-types";
import type { GateStatus } from "./transfer-basis";

// Pure stage-transition helpers for the T3 detail route + server actions
// (TDD ticket ADR-2). No Prisma import — unit-testable without the client,
// the transfer-basis idiom carried.

/**
 * Derived days-in-stage (ADR-2: never a stored counter). Whole elapsed days
 * since `stage_entered_at`, floored, clamped at 0 (a same-day transition — or
 * a clock-skewed future timestamp — reads as day 0, never -1).
 */
export function daysInStage(stageEnteredAt: Date, now: Date = new Date()): number {
  const ms = now.getTime() - stageEnteredAt.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Soft-gate warnings for a stage transition (locked, the owner 2026-07-02:
 * gates are SOFT — warn + allow + audit; nothing is ever blocked).
 *
 * Moving FORWARD past a stage whose gate is not satisfied yields one warning
 * per skipped-or-left stage in `[from, to)` — the stages whose gates the move
 * asserts are done. Backward moves and no-ops warn about nothing (returning
 * to earlier work is always legitimate). The caller shows the warnings and
 * proceeds regardless; the audit trail is the control (ADR-2).
 *
 * `gates` is the record's full `gateStatus(...)` output (one entry per stage
 * in STAGE_ORDER, `satisfied` derived from the structured child data).
 */
export function stageChangeWarnings(
  gates: readonly GateStatus[],
  from: TransferStage,
  to: TransferStage,
): string[] {
  const fromIdx = STAGE_ORDER.indexOf(from);
  const toIdx = STAGE_ORDER.indexOf(to);
  if (toIdx <= fromIdx) return [];

  const warnings: string[] = [];
  for (let i = fromIdx; i < toIdx; i++) {
    const gate = gates.find((g) => g.stage === STAGE_ORDER[i]);
    if (gate && !gate.satisfied) {
      warnings.push(`Gate not met — ${gate.label}: ${gate.gate}.`);
    }
  }
  return warnings;
}
