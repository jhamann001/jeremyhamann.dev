import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transactionSpy, querySpy } = vi.hoisted(() => {
  const query = vi.fn();
  return {
    querySpy: query,
    transactionSpy: vi.fn(async (_identity, fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: query })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({
  withUserScope: transactionSpy,
}));

import {
  CRM_RELATIONSHIP_MAX_DEPTH,
  CRM_RELATIONSHIP_READ_ROLES,
  CRM_RELATIONSHIP_ROW_LIMIT,
  CRM_RELATIONSHIP_TRANSACTION_MAX_WAIT_MS,
  CRM_RELATIONSHIP_TRANSACTION_TIMEOUT_MS,
  canReadCrmRelationships,
  getCrmRelationshipTraversal,
  hasCrmRelationshipReadContext,
  normalizeCrmRelationshipDepth,
  normalizeCrmRelationshipTypes,
  validateCrmRelationshipRoot,
} from "@/lib/data/crm-relationships";

const OPS = { role: "OPERATIONS", email: "ops@example.test" };

function rootRow() {
  return [{ id: "hld_fixture", identity_type: "HOUSEHOLD" }];
}

describe("CRM relationship read seam", () => {
  beforeEach(() => {
    process.env.CRM_RELATIONSHIPS = "1";
    transactionSpy.mockClear();
    querySpy.mockReset();
    querySpy.mockResolvedValueOnce(rootRow()).mockResolvedValueOnce([]);
  });

  afterEach(() => {
    delete process.env.CRM_RELATIONSHIPS;
    vi.restoreAllMocks();
  });

  it("permits exactly ADMIN and OPERATIONS with a complete session context", () => {
    expect([...CRM_RELATIONSHIP_READ_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
    for (const role of ["ADMIN", "OPERATIONS"]) {
      expect(canReadCrmRelationships(role)).toBe(true);
      expect(hasCrmRelationshipReadContext({ role, email: "reader@example.test" })).toBe(true);
    }
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", null]) {
      expect(canReadCrmRelationships(role)).toBe(false);
    }
    expect(hasCrmRelationshipReadContext({ role: "OPERATIONS", email: "" })).toBe(false);
    expect(hasCrmRelationshipReadContext({ role: "ADMIN" })).toBe(false);
  });

  it("fails before database work for forbidden, missing-context, and disabled calls", async () => {
    await expect(getCrmRelationshipTraversal(
      { role: "ADVISOR", email: "advisor@example.test" },
      "hld_fixture",
    )).resolves.toEqual({ ok: false, reason: "forbidden" });
    await expect(getCrmRelationshipTraversal(
      { role: "OPERATIONS", email: null },
      "hld_fixture",
    )).resolves.toEqual({ ok: false, reason: "missing_context" });

    delete process.env.CRM_RELATIONSHIPS;
    await expect(getCrmRelationshipTraversal(OPS, "hld_fixture")).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed, record, unsupported, and relationship IDs", () => {
    expect(validateCrmRelationshipRoot("not-an-id")).toEqual({
      ok: false,
      reason: "invalid_identity_id",
    });
    expect(validateCrmRelationshipRoot("eml_fixture")).toEqual({
      ok: false,
      reason: "record_identity_id",
    });
    expect(validateCrmRelationshipRoot("tsk_fixture")).toEqual({
      ok: false,
      reason: "unsupported_identity_type",
    });
    expect(validateCrmRelationshipRoot("rel_fixture")).toEqual({
      ok: false,
      reason: "invalid_identity_id",
    });
    expect(validateCrmRelationshipRoot("hld_fixture")).toEqual({
      ok: true,
      type: "HOUSEHOLD",
    });
  });

  it("enforces depth and relationship catalogs before database work", async () => {
    expect(CRM_RELATIONSHIP_MAX_DEPTH).toBe(4);
    expect(normalizeCrmRelationshipDepth(undefined)).toBe(1);
    expect(normalizeCrmRelationshipDepth(4)).toBe(4);
    for (const depth of [0, 5, 1.5, "2", null]) {
      expect(normalizeCrmRelationshipDepth(depth)).toBeNull();
    }
    expect(normalizeCrmRelationshipTypes(undefined)).toEqual([
      "HOUSEHOLD_HAS_MEMBER",
      "DEAL_FOR_HOUSEHOLD",
      "TRANSFER_FOR_HOUSEHOLD",
    ]);
    expect(normalizeCrmRelationshipTypes([
      "TRANSFER_FOR_HOUSEHOLD",
      "TRANSFER_FOR_HOUSEHOLD",
    ])).toEqual(["TRANSFER_FOR_HOUSEHOLD"]);
    expect(normalizeCrmRelationshipTypes([])).toBeNull();
    expect(normalizeCrmRelationshipTypes(["PERSON_AUTHORIZES_PERSON"])).toBeNull();

    await expect(getCrmRelationshipTraversal(OPS, "hld_fixture", {
      maxDepth: 5,
    })).resolves.toEqual({ ok: false, reason: "invalid_depth" });
    await expect(getCrmRelationshipTraversal(OPS, "hld_fixture", {
      relationshipTypes: ["UNKNOWN"],
    })).resolves.toEqual({ ok: false, reason: "invalid_relationship_type" });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("returns only typed graph coordinates with bounded transaction options", async () => {
    querySpy.mockReset();
    querySpy.mockResolvedValueOnce(rootRow()).mockResolvedValueOnce([{
      relationship_id: "rel_fixture",
      relationship_type: "HOUSEHOLD_HAS_MEMBER",
      from_identity_id: "hld_fixture",
      to_identity_id: "con_fixture",
      parent_identity_id: "hld_fixture",
      endpoint_identity_id: "con_fixture",
      endpoint_identity_type: "CONTACT",
      direction: "OUTGOING",
      depth: 1,
    }]);

    await expect(getCrmRelationshipTraversal(OPS, "hld_fixture", {
      maxDepth: 2,
      relationshipTypes: ["HOUSEHOLD_HAS_MEMBER"],
    })).resolves.toEqual({
      ok: true,
      rootIdentityId: "hld_fixture",
      rootIdentityType: "HOUSEHOLD",
      maxDepth: 2,
      relationshipTypes: ["HOUSEHOLD_HAS_MEMBER"],
      rows: [{
        relationshipId: "rel_fixture",
        relationshipType: "HOUSEHOLD_HAS_MEMBER",
        fromIdentityId: "hld_fixture",
        toIdentityId: "con_fixture",
        parentIdentityId: "hld_fixture",
        endpointIdentityId: "con_fixture",
        endpointIdentityType: "CONTACT",
        direction: "OUTGOING",
        depth: 1,
      }],
    });
    expect(transactionSpy).toHaveBeenCalledWith(
      OPS,
      expect.any(Function),
      {
        timeout: CRM_RELATIONSHIP_TRANSACTION_TIMEOUT_MS,
        maxWait: CRM_RELATIONSHIP_TRANSACTION_MAX_WAIT_MS,
      },
    );
  });

  it("fails closed on an inactive/missing root and on row overflow", async () => {
    querySpy.mockReset();
    querySpy.mockResolvedValueOnce([]);
    await expect(getCrmRelationshipTraversal(OPS, "hld_fixture")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });

    querySpy.mockReset();
    querySpy.mockResolvedValueOnce(rootRow()).mockResolvedValueOnce(
      Array.from({ length: CRM_RELATIONSHIP_ROW_LIMIT + 1 }, (_, index) => ({
        relationship_id: `rel_${index}`,
        relationship_type: "HOUSEHOLD_HAS_MEMBER",
        from_identity_id: "hld_fixture",
        to_identity_id: `con_${index}`,
        parent_identity_id: "hld_fixture",
        endpoint_identity_id: `con_${index}`,
        endpoint_identity_type: "CONTACT",
        direction: "OUTGOING",
        depth: 1,
      })),
    );
    await expect(getCrmRelationshipTraversal(OPS, "hld_fixture")).resolves.toEqual({
      ok: false,
      reason: "row_limit_exceeded",
    });
  });
});
