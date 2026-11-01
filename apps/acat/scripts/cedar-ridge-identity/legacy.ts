import { sha256 } from "./canonical";
import { auditProvenanceSchema, manifestSchema, trackerSnapshotSchema, undoPlanSchema } from "./legacy-contracts";

/** Old bytes remain inspectable, but are never silently promoted into set approval. */
export function inspectLegacy(input: unknown) {
  for (const [kind, schema] of [
    ["manifest", manifestSchema], ["snapshot", trackerSnapshotSchema],
    ["undo-plan", undoPlanSchema], ["audit", auditProvenanceSchema],
  ] as const) {
    const result = schema.safeParse(input);
    if (result.success) {
      return { version: 1, kind, artifactHash: sha256(input), readOnly: true,
        actionable: false, requiredAction: "Take a v2 snapshot and create a new reviewed, bound, approved v2 manifest.",
        ...(kind === "manifest" ? { records: manifestSchema.parse(input).rows.length } : {}),
        ...(kind === "snapshot" ? { records: trackerSnapshotSchema.parse(input).records.length } : {}),
      };
    }
  }
  throw new Error("LEGACY_ARTIFACT_INVALID");
}

export function rejectLegacyWrite(input: unknown): void {
  if (typeof input === "object" && input !== null && "version" in input && input.version === 1) {
    throw new Error("LEGACY_ARTIFACT_READ_ONLY");
  }
}
