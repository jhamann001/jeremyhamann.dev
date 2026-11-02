import { z } from "zod";
import { custodianLibrarySchema } from "./custodian-library-contract";

export type AcatWorkspaceView = "tracking" | "library";
export const ACAT_WORKSPACE_TTL = { library: 300_000, tracking: 30_000 } as const;
export const acatWorkspaceView = (value: unknown): AcatWorkspaceView => value === "library" ? "library" : "tracking";
const text = z.string().nullable();
const number = z.number().finite().nullable();
const count = z.number().int().nonnegative();
const trackingRow = z.object({
  id: z.string().min(1), acatTransferId: z.string(), clientName: text,
  controlNumber: text, direction: text, type: text, accountType: text,
  status: text, transferringContra: text, statementAmount: number,
  acatDate: text, lastActivityAt: text, apexAccountId: text,
  statementAccountNumber: text, dtccNumber: text,
  assetMap: z.object({ total: number, mapped: number, unmapped: number, pending: number, expected: number }),
  linked: z.boolean(), transferId: text, needsAttention: z.boolean(),
});
export const acatTrackingSchema = z.object({
  summary: z.object({ total: count, inFlight: count, attention: count, completed: count, needsAttention: count, linked: count, unlinked: count }),
  groups: z.array(z.object({ label: z.string(), order: z.number().finite(),
    tone: z.enum(["accepted", "submitted", "rejected", "neutral"]),
    phase: z.enum(["in_flight", "attention", "completed"]), count, rows: z.array(trackingRow) })),
});
const metadata = { checkedAt: count, expiresAt: count };
export const acatWorkspaceSnapshotSchema = z.discriminatedUnion("view", [
  z.object({ view: z.literal("library"), ...metadata, data: custodianLibrarySchema }),
  z.object({ view: z.literal("tracking"), ...metadata, data: acatTrackingSchema }),
]).refine((s) => s.expiresAt - s.checkedAt === ACAT_WORKSPACE_TTL[s.view]);
export type AcatWorkspaceSnapshot = z.infer<typeof acatWorkspaceSnapshotSchema>;
export const acatWorkspaceResponseSchema = z.object({
  scope: z.string().min(1), serverNow: count, sessionExpiresAt: count,
  snapshot: acatWorkspaceSnapshotSchema,
});
export type AcatWorkspaceResponse = z.infer<typeof acatWorkspaceResponseSchema>;
