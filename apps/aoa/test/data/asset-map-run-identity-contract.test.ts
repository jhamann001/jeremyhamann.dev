import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_VALUES,
  COVERAGE_VALUES,
  DECISION_STATES,
  MAX_PEOPLE_PER_RUN,
  MAX_PERSON_ID_LENGTH,
  RESOLUTION_OUTCOMES,
  REVIEW_STATES,
  RUN_IDENTITY_SCHEMA_VERSION,
  compareCodePoints,
  identityPayloadDigest,
  isDerivedUseBlocked,
  parseRunIdentity,
  type AvailableRunIdentity,
} from "@/lib/data/asset-map-run-identity/contract";
import { FIXTURE_PATH, clientLink, fixtureVector, loadMachineExportFixture } from "../asset-map-run-identity/fixtures";

const FIXTURE_SHA256 = "381edbf664a25360ccd4709d39c22058f28cbc9e3189830cecf5166f8e059301";
const RUN = "11111111-1111-4111-8111-111111111111";

function available(name: string, overrides: Record<string, unknown> = {}): AvailableRunIdentity {
  const vector = fixtureVector(name);
  const parsed = parseRunIdentity(vector.run_id, { ...vector.client_link, ...overrides });
  if (!parsed.ok) throw new Error(`fixture ${name} failed: ${parsed.reason}`);
  if (parsed.value.availability !== "available") throw new Error("expected available");
  return parsed.value;
}

function rejected(overrides: Record<string, unknown>, name = "singleton", runId: unknown = RUN) {
  return parseRunIdentity(runId, clientLink(name, overrides));
}

describe("frozen contract enums", () => {
  it("match contract v1 exactly", () => {
    expect(RUN_IDENTITY_SCHEMA_VERSION).toBe(1);
    expect([...DECISION_STATES]).toEqual(["linked", "unlinked", "unreviewed"]);
    expect([...COVERAGE_VALUES]).toEqual(["complete", "partial"]);
    expect([...REVIEW_STATES]).toEqual(["complete", "partial", "unresolved", "conflict"]);
    expect([...AVAILABILITY_VALUES]).toEqual(["available", "unavailable"]);
    expect([...RESOLUTION_OUTCOMES]).toEqual(["resolved", "missing", "ambiguous", "conflict"]);
  });
});

describe("shared machine export fixture", () => {
  it("is the frozen byte-exact fixture: sorted keys, 2-space indent, trailing newline", () => {
    const bytes = readFileSync(FIXTURE_PATH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_SHA256);
    const text = bytes.toString("utf8");
    const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
        : v;
    expect(`${JSON.stringify(sortKeys(JSON.parse(text)), null, 2)}\n`).toBe(text);
  });

  it("uses only the invented vector ids and every vector parses", () => {
    const fixture = loadMachineExportFixture();
    expect(fixture.vectors.map((v) => v.run_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
      const d = String(n);
      return `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
    }));
    for (const vector of fixture.vectors) {
      const parsed = parseRunIdentity(vector.run_id, vector.client_link);
      expect(parsed.ok, vector.name).toBe(true);
    }
    expect(parseRunIdentity(RUN, fixture.unavailable)).toEqual({
      ok: true,
      value: { runId: RUN, schemaVersion: 1, availability: "unavailable", reason: "client_linking_disabled" },
    });
  });

  it("maps singleton, shared, explicit primary and partial vectors faithfully", () => {
    expect(available("singleton")).toEqual({
      runId: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 1,
      availability: "available",
      identityVersion: 1,
      decisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      decisionState: "linked",
      peopleIds: ["cr-solo"],
      coverage: "complete",
      primaryUserId: "cr-solo",
      cedarRidgeUserId: "cr-solo",
      reviewState: "complete",
      conflictFlags: [],
    });
    expect(available("shared_no_primary")).toMatchObject({
      peopleIds: ["cr-a", "cr-b"], primaryUserId: null, cedarRidgeUserId: null, coverage: "complete",
    });
    expect(available("explicit_primary")).toMatchObject({
      peopleIds: ["cr-primary", "cr-secondary"], primaryUserId: "cr-primary", cedarRidgeUserId: "cr-primary",
    });
    expect(available("partial")).toMatchObject({
      peopleIds: ["cr-partial"], coverage: "partial", reviewState: "partial", cedarRidgeUserId: null,
    });
  });

  it("keeps unknown and known conflict codes and blocks derived use", () => {
    const conflict = available("conflict");
    expect(conflict.conflictFlags).toEqual(["UNKNOWN_CODE", "folder_holder_mismatch"]);
    expect(conflict.peopleIds).toEqual(["cr-conflict"]);
    expect(isDerivedUseBlocked(conflict)).toBe(true);
    expect(isDerivedUseBlocked(available("singleton"))).toBe(false);

    const knownOnly = parseRunIdentity(fixtureVector("conflict").run_id,
      clientLink("conflict", { conflict_flags: ["folder_holder_mismatch"] }));
    expect(knownOnly.ok).toBe(true);
    if (!knownOnly.ok || knownOnly.value.availability !== "available") throw new Error("expected available");
    expect(knownOnly.value.reviewState).toBe("conflict");
    expect(isDerivedUseBlocked(knownOnly.value)).toBe(true);
  });

  it("accepts truthful null decision ids only where the contract allows", () => {
    expect(available("unreviewed")).toMatchObject({ decisionId: null, decisionState: "unreviewed", identityVersion: 0 });
    expect(available("explicit_unlinked")).toMatchObject({ decisionState: "unlinked", peopleIds: [] });
    expect(available("first_confirmation_reversal")).toMatchObject({ decisionId: null, decisionState: "unlinked" });
  });
});

describe("parseRunIdentity rejects non-authoritative input", () => {
  it("treats an absent object as missing, never as unlinked", () => {
    expect(parseRunIdentity(RUN, undefined)).toMatchObject({ ok: false, reason: "missing" });
    expect(parseRunIdentity(RUN, null)).toMatchObject({ ok: false, reason: "missing" });
  });

  it("separates unsupported versions from malformed versions", () => {
    expect(rejected({ schema_version: 2 })).toMatchObject({ ok: false, reason: "unsupported_schema_version" });
    expect(rejected({ schema_version: "1" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(rejected({ schema_version: undefined })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it.each([
    ["uppercase run id", "11111111-1111-4111-8111-11111111111A"],
    ["non-uuid run id", "run-1"],
    ["numeric run id", 1],
  ])("rejects %s", (_label, runId) => {
    expect(rejected({}, "singleton", runId)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it.each([
    ["unsorted people", { people_ids: ["cr-b", "cr-a"] }, "shared_no_primary"],
    ["duplicate people", { people_ids: ["cr-a", "cr-a"] }, "shared_no_primary"],
    ["empty person id", { people_ids: ["", "cr-a"] }, "shared_no_primary"],
    ["whitespace person id", { people_ids: [" \t", "cr-a"] }, "shared_no_primary"],
    ["numeric person id", { people_ids: [7, "cr-a"] }, "shared_no_primary"],
    ["non-array people", { people_ids: "cr-a" }, "shared_no_primary"],
    ["negative version", { identity_version: -1 }, "singleton"],
    ["fractional version", { identity_version: 1.5 }, "singleton"],
    ["unsafe version", { identity_version: Number.MAX_SAFE_INTEGER + 1 }, "singleton"],
    ["string version", { identity_version: "1" }, "singleton"],
    ["invalid decision uuid", { decision_id: "not-a-uuid" }, "singleton"],
    ["unknown decision state", { decision_state: "accepted" }, "singleton"],
    ["unknown coverage", { coverage: "full" }, "singleton"],
    ["unknown review state", { review_state: "done" }, "singleton"],
    ["linked without people", { people_ids: [], primary_user_id: null, cedar_ridge_user_id: null, coverage: "partial", review_state: "unresolved" }, "singleton"],
    ["linked without decision", { decision_id: null }, "singleton"],
    ["unreviewed with decision", { decision_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "unreviewed"],
    ["unreviewed with people", { people_ids: ["cr-x"], coverage: "partial", review_state: "partial" }, "unreviewed"],
    ["unlinked with people", { people_ids: ["cr-x"], review_state: "partial" }, "explicit_unlinked"],
    ["empty set marked complete", { coverage: "complete" }, "explicit_unlinked"],
    ["primary outside accepted set", { primary_user_id: "cr-other", cedar_ridge_user_id: "cr-other" }, "singleton"],
    ["scalar without primary on shared run", { cedar_ridge_user_id: "cr-a" }, "shared_no_primary"],
    ["missing scalar on complete singleton", { primary_user_id: null, cedar_ridge_user_id: null }, "singleton"],
    ["scalar on partial singleton", { cedar_ridge_user_id: "cr-partial" }, "partial"],
    ["scalar differing from primary", { cedar_ridge_user_id: "cr-secondary" }, "explicit_primary"],
    ["conflict flags without conflict review", { review_state: "complete" }, "conflict"],
    ["conflict review without flags", { conflict_flags: [] }, "conflict"],
    ["unsorted conflict flags", { conflict_flags: ["b_code", "A_CODE", "a_code"].reverse() }, "conflict"],
    ["duplicate conflict flags", { conflict_flags: ["UNKNOWN_CODE", "UNKNOWN_CODE"] }, "conflict"],
    ["empty conflict flag", { conflict_flags: [""] }, "conflict"],
    ["partial review on complete coverage", { review_state: "partial" }, "singleton"],
    ["unexpected field", { display_name: "Synthetic" }, "singleton"],
    ["unavailable reason on available object", { reason: "client_linking_disabled" }, "singleton"],
    ["unknown availability", { availability: "maybe" }, "singleton"],
  ])("rejects %s as malformed", (_label, overrides, name) => {
    expect(rejected(overrides, name)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("rejects malformed unavailable objects", () => {
    const base = { schema_version: 1, availability: "unavailable", reason: "client_linking_disabled" };
    expect(parseRunIdentity(RUN, { ...base, reason: "db_error" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(parseRunIdentity(RUN, { ...base, reason: undefined })).toMatchObject({ ok: false, reason: "malformed" });
    expect(parseRunIdentity(RUN, { ...base, people_ids: [] })).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("enforces explicit safety caps instead of truncating", () => {
    const many = Array.from({ length: MAX_PEOPLE_PER_RUN + 1 }, (_, i) => `cr-${String(i).padStart(4, "0")}`);
    expect(rejected({ people_ids: many }, "shared_no_primary")).toMatchObject({ ok: false, reason: "malformed" });
    const ok = many.slice(0, MAX_PEOPLE_PER_RUN);
    expect(rejected({ people_ids: ok }, "shared_no_primary")).toMatchObject({ ok: true });
    const long = "x".repeat(MAX_PERSON_ID_LENGTH + 1);
    expect(rejected({ people_ids: [long, "y"] }, "shared_no_primary")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("never echoes person ids in failure details", () => {
    const result = rejected({ people_ids: ["secret-b", "secret-a"] }, "shared_no_primary");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("opaque id ordering and case sensitivity", () => {
  it("orders by Unicode code point (matching the producer), not UTF-16 units", () => {
    expect(compareCodePoints("\uFFFF", "\u{1F600}")).toBeLessThan(0);
    expect(compareCodePoints("EG-A", "cr-a")).toBeLessThan(0);
    expect(rejected({ people_ids: ["\uFFFF", "\u{1F600}"] }, "shared_no_primary")).toMatchObject({ ok: true });
    expect(rejected({ people_ids: ["\u{1F600}", "\uFFFF"] }, "shared_no_primary")).toMatchObject({ ok: false });
  });

  it("keeps Cedar Ridge ids case-sensitive and distinct", () => {
    const parsed = rejected({ people_ids: ["EG-A", "cr-a"] }, "shared_no_primary");
    expect(parsed).toMatchObject({ ok: true, value: { peopleIds: ["EG-A", "cr-a"] } });
  });
});

describe("canonical identity digest", () => {
  it("excludes identity_version and input key order", () => {
    const a = available("singleton");
    const b = available("singleton", { identity_version: 9 });
    expect(identityPayloadDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(identityPayloadDigest(b)).toBe(identityPayloadDigest(a));
    const reordered = Object.fromEntries(Object.entries(clientLink("singleton")).reverse());
    const parsed = parseRunIdentity(RUN, reordered);
    expect(parsed.ok && parsed.value.availability === "available" && identityPayloadDigest(parsed.value))
      .toBe(identityPayloadDigest(a));
  });

  it.each([
    ["decision id", { decision_id: "abababab-abab-4bab-8bab-abababababab" }],
    ["conflict flags", { conflict_flags: ["UNKNOWN_CODE"], review_state: "conflict" }],
    ["coverage", { coverage: "partial", review_state: "partial", cedar_ridge_user_id: "cr-solo" }],
  ])("changes when %s changes", (_label, overrides) => {
    expect(identityPayloadDigest(available("singleton", overrides))).not.toBe(identityPayloadDigest(available("singleton")));
  });

  it("distinguishes the two empty unlinked forms", () => {
    expect(identityPayloadDigest(available("explicit_unlinked")))
      .not.toBe(identityPayloadDigest(available("first_confirmation_reversal")));
  });
});
