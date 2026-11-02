import type { PillTone } from "@/components/ui";

// Temperature tone-word → PillTone (T4, TDD ADR-10; extraction §1): the
// mockup's rule made total — Sensitive/Stalled → red, Done/Smooth → green,
// anything else → gold (watchful middle). Kept beside the components like
// transfer-stage-tone.ts; pure and unit-tested (test/temperature-tone.test.ts).

const RED = new Set(["Sensitive", "Stalled"]);
const GREEN = new Set(["Done", "Smooth"]);

export function temperatureTone(tone: string): PillTone {
  if (RED.has(tone)) return "red";
  if (GREEN.has(tone)) return "green";
  return "gold";
}
