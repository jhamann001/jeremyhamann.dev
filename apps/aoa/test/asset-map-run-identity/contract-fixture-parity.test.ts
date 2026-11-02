import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canonicalIdentityJson,
  expectedCedarRidgeUserId,
  expectedReviewState,
  identityPayloadDigest,
  parseRunIdentity,
  type AvailableRunIdentity,
} from "@/lib/data/asset-map-run-identity/contract";

import { FIXTURE_PATH, loadMachineExportFixture } from "./fixtures";

// Producer/consumer parity for the frozen client_link v1 vectors (ticket).
//
// The producer (cedar-ridge-wealth/statement-pipeline, ticket) owns
// tests/fixtures/client_linking/machine_export_v1.json; the consumer copy in
// this directory (ticket) must stay byte-identical to it. The digest below is
// the integration lead's frozen value; changing either copy requires a
// coordinated contract amendment, not an edit to this constant.
const FROZEN_FIXTURE_SHA256 = "381edbf664a25360ccd4709d39c22058f28cbc9e3189830cecf5166f8e059301";
const FROZEN_VECTOR_NAMES = [
  "singleton",
  "shared_no_primary",
  "explicit_primary",
  "partial",
  "conflict",
  "unreviewed",
  "explicit_unlinked",
  "first_confirmation_reversal",
];

const raw = readFileSync(FIXTURE_PATH);
const fixture = loadMachineExportFixture();

/** Python `json.dumps(value, indent=2, sort_keys=True) + "\n"` for ASCII JSON. */
function producerSerialization(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

describe("client_link v1 fixture parity (producer ticket ↔ consumer ticket)", () => {
  it("keeps the consumer copy byte-identical to the frozen producer digest", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FROZEN_FIXTURE_SHA256);
  });

  it("uses the producer's canonical serialization, so a re-export cannot drift silently", () => {
    const text = raw.toString("utf8");
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(text)).toBe(true);
    expect(producerSerialization(JSON.parse(text))).toBe(text);
  });

  it("declares contract v1 and exactly the frozen vectors in order", () => {
    expect(fixture.contract).toBe("acat-run-identity-export");
    expect(fixture.schema_version).toBe(1);
    expect(fixture.vectors.map((v) => v.name)).toEqual(FROZEN_VECTOR_NAMES);
    expect(new Set(fixture.vectors.map((v) => v.run_id)).size).toBe(fixture.vectors.length);
  });

  it("parses the unavailable object as unavailable, never as an empty link", () => {
    const parsed = parseRunIdentity(fixture.vectors[0].run_id, fixture.unavailable);
    expect(parsed).toEqual({
      ok: true,
      value: {
        runId: fixture.vectors[0].run_id,
        schemaVersion: 1,
        availability: "unavailable",
        reason: "client_linking_disabled",
      },
    });
  });

  it.each(fixture.vectors.map((v) => [v.name, v] as const))(
    "consumer accepts producer vector %s without coercion",
    (_name, vector) => {
      const parsed = parseRunIdentity(vector.run_id, vector.client_link);
      expect(parsed.ok).toBe(true);
      const identity = (parsed as { ok: true; value: AvailableRunIdentity }).value;
      const link = vector.client_link;
      expect({
        identity_version: identity.identityVersion,
        decision_id: identity.decisionId,
        decision_state: identity.decisionState,
        people_ids: identity.peopleIds,
        coverage: identity.coverage,
        primary_user_id: identity.primaryUserId,
        cedar_ridge_user_id: identity.cedarRidgeUserId,
        review_state: identity.reviewState,
        conflict_flags: identity.conflictFlags,
      }).toEqual({
        identity_version: link.identity_version,
        decision_id: link.decision_id,
        decision_state: link.decision_state,
        people_ids: link.people_ids,
        coverage: link.coverage,
        primary_user_id: link.primary_user_id,
        cedar_ridge_user_id: link.cedar_ridge_user_id,
        review_state: link.review_state,
        conflict_flags: link.conflict_flags,
      });
      expect(identity.cedarRidgeUserId).toBe(expectedCedarRidgeUserId(identity));
      expect(identity.reviewState).toBe(expectedReviewState(identity));
      expect(JSON.parse(canonicalIdentityJson(identity))).not.toHaveProperty("identity_version");
      expect(identityPayloadDigest(identity)).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("contains invented identifiers only", () => {
    for (const vector of fixture.vectors) {
      expect(vector.run_id).toMatch(/^([1-8])\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/);
      const link = vector.client_link as { decision_id: string | null; people_ids: string[] };
      if (link.decision_id !== null) expect(link.decision_id).toMatch(/^([a-f])\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/);
      for (const person of link.people_ids) expect(person).toMatch(/^cr-[a-z]+$/);
    }
  });
});
