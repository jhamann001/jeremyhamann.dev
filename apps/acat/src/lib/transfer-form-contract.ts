import { z } from "zod";
import { receivingRegistrationSchema } from "./transfer-registration";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const text = z.string().max(10000);
export const transferFormIdSchema = id;
export const assetInstructionSchema = z.enum(["IN_KIND", "LIQUIDATE"]);
export const transferPacketInstructionSchema = z.enum(["IN_KIND", "LIQUIDATE", "MIXED"]);
export const positionInstructionSchema = z.object({
  positionId: id, assetInstruction: assetInstructionSchema,
}).strict();
export const transferFormPreparationSchema = z.object({
  schemaVersion: z.literal(1), recordId: id, sourceRevision: revision, checkedAt: timestamp,
  direction: z.enum(["INCOMING", "OUTGOING", "UNKNOWN"]),
  scope: z.enum(["FULL", "PARTIAL", "UNKNOWN"]),
  transferMethod: z.enum(["ACAT", "MANUAL", "DRS", "RESIDUAL", "UNCLASSIFIED"]).default("UNCLASSIFIED"),
  custodian: z.object({ id, name: text }).nullable(),
  accounts: z.object({
    receivingMasked: text, deliveringMasked: text,
    receivingTitleSuggestion: text, deliveringTitleSuggestion: text,
    registrationSuggestion: text.nullable(),
  }),
  confirmation: z.object({
    id: id.nullable(), title: text, registration: text.nullable(),
    confirmedBy: text.nullable(), confirmedAt: timestamp.nullable(),
    valid: z.boolean(), source: z.enum(["OPS_PORTAL", "TRACKER_LEGACY"]),
  }).nullable(),
  workflows: z.array(z.object({
    id, name: text, automated: z.boolean(), requiresReceivingAccountNumber: z.boolean(),
    handling: z.object({ mode: z.enum(["FIXED", "CLIENT_DIRECTED"]), options: z.array(assetInstructionSchema).min(1).max(2) }),
    note: text.nullable(),
    template: z.enum([
      "APEX_CUSTOMER_ACCOUNT_TRANSFER_REQUEST",
      "EMPOWER_WITHDRAWAL_DIRECT_ROLLOVER_TRANSFER_REQUEST",
    ]).optional(),
  })).max(50),
  positions: z.array(z.object({
    id, symbol: text, description: text, quantity: z.number().finite(), include: z.boolean().nullable(),
  })).max(5000),
  inheritedTitleReview: z.boolean(),
  requirements: z.array(z.object({ label: text, value: text })).max(50),
  notices: z.array(text).max(50),
  blockers: z.array(z.object({ code: id, message: text })).max(50),
  documents: z.array(z.object({
    id, filename: text, createdBy: text, createdAt: timestamp, sha256: revision,
  })).max(100),
  ruleVersion: text,
});

export const confirmReceivingTitleSchema = z.object({
  expectedRevision: revision, operationId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  registration: receivingRegistrationSchema, confirmed: z.literal(true),
}).strict();
export const updateTransferScopeSchema = z.object({
  expectedRevision: revision, operationId: z.string().uuid(),
  scope: z.enum(["FULL", "PARTIAL"]), confirmed: z.literal(true),
}).strict();
export const generateTransferFormSchema = z.object({
  expectedRevision: revision, confirmationId: id, operationId: z.string().uuid(),
  workflowId: id, assetInstruction: transferPacketInstructionSchema,
  positionInstructions: z.array(positionInstructionSchema).min(2).max(5000).optional(),
  deliveringTitle: z.string().trim().min(1).max(200), deliveringTitleConfirmed: z.literal(true),
  receivingAccountNumber: z.string().trim().min(1).max(100).optional(),
  receivingAccountNumberVerified: z.literal(true).optional(),
  accountsReviewed: z.literal(true), instructionsReviewed: z.literal(true),
  letterOfAuthorizationRequired: z.boolean(),
}).strict().superRefine((request, ctx) => {
  if (request.assetInstruction !== "MIXED") {
    if (request.positionInstructions !== undefined) ctx.addIssue({ code: "custom", path: ["positionInstructions"],
      message: "Per-position instructions require a mixed packet." });
    return;
  }
  const instructions = request.positionInstructions;
  if (!instructions) {
    ctx.addIssue({ code: "custom", path: ["positionInstructions"], message: "Choose an instruction for every included position." });
    return;
  }
  if (new Set(instructions.map((item) => item.positionId)).size !== instructions.length) {
    ctx.addIssue({ code: "custom", path: ["positionInstructions"], message: "Each position must appear once." });
  }
  if (new Set(instructions.map((item) => item.assetInstruction)).size !== 2) {
    ctx.addIssue({ code: "custom", path: ["positionInstructions"], message: "A mixed packet requires both instructions." });
  }
});

export type TransferFormPreparation = z.infer<typeof transferFormPreparationSchema>;
export type ConfirmReceivingTitle = z.infer<typeof confirmReceivingTitleSchema>;
export type UpdateTransferScope = z.infer<typeof updateTransferScopeSchema>;
export type GenerateTransferForm = z.infer<typeof generateTransferFormSchema>;
export type TransferFormFailureReason = "disabled" | "forbidden" | "invalid" | "not_found" | "stale" | "unavailable" | "review_required";
export type TransferFormResult<T> = { ok: true; data: T } | { ok: false; reason: TransferFormFailureReason };
