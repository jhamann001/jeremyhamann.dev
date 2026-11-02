import { describe, expect, it } from "vitest";
import {
  CRM_EDGE_TYPE_CATALOG,
  CRM_ID_CATALOG,
  CRM_PHASE_4_DERIVATION_CATALOG,
  crmIdMatchesType,
  type CrmIdType,
} from "@/lib/crm/contracts";
import {
  CRM_PRIVACY_FIXTURE_EDGES,
  CRM_PRIVACY_FIXTURE_ENTITIES,
  CRM_PRIVACY_SCENARIOS,
} from "@/test/fixtures/crm-privacy-scenarios";

describe("CRM typed ID catalog", () => {
  it("reserves unique, uniformly three-character prefixes", () => {
    const prefixes = Object.values(CRM_ID_CATALOG).map((entry) => entry.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) expect(prefix).toMatch(/^[a-z]{3}$/);
  });

  it("distinguishes graph entities, event records, and relationship rows", () => {
    expect(CRM_ID_CATALOG.HOUSEHOLD).toMatchObject({
      kind: "ENTITY",
      graphEndpoint: true,
    });
    expect(CRM_ID_CATALOG.EMAIL).toMatchObject({
      kind: "RECORD",
      graphEndpoint: false,
    });
    expect(CRM_ID_CATALOG.RELATIONSHIP).toMatchObject({
      kind: "RELATIONSHIP",
      graphEndpoint: false,
    });
  });

  it("matches only the requested type and requires an ID body", () => {
    expect(crmIdMatchesType("HOUSEHOLD", "hld_fixture")).toBe(true);
    expect(crmIdMatchesType("HOUSEHOLD", "con_fixture")).toBe(false);
    expect(crmIdMatchesType("HOUSEHOLD", "hld_")).toBe(false);
  });
});

describe("CRM relationship catalog", () => {
  it("uses only graph-approved entity types as edge endpoints", () => {
    for (const edge of Object.values(CRM_EDGE_TYPE_CATALOG)) {
      for (const type of [...edge.fromTypes, ...edge.toTypes]) {
        expect(CRM_ID_CATALOG[type]).toMatchObject({
          kind: "ENTITY",
          graphEndpoint: true,
        });
      }
    }
  });

  it("allows only explicit, revocable consent edges to bear permission", () => {
    const permissionEdges = Object.entries(CRM_EDGE_TYPE_CATALOG)
      .filter(([, entry]) => entry.permissionBearing)
      .map(([type]) => type)
      .sort();

    expect(permissionEdges).toEqual([
      "HOUSEHOLD_AUTHORIZES_THIRD_PARTY",
      "PERSON_AUTHORIZES_PERSON",
    ]);
    for (const type of permissionEdges) {
      expect(
        CRM_EDGE_TYPE_CATALOG[type as keyof typeof CRM_EDGE_TYPE_CATALOG].revocable,
      ).toBe(true);
    }
  });

  it("does not treat family, ownership, service, or document facts as permission", () => {
    expect(CRM_EDGE_TYPE_CATALOG.HOUSEHOLD_HAS_MEMBER.permissionBearing).toBe(false);
    expect(CRM_EDGE_TYPE_CATALOG.PERSON_OWNS_ACCOUNT.permissionBearing).toBe(false);
    expect(CRM_EDGE_TYPE_CATALOG.THIRD_PARTY_SERVES_HOUSEHOLD.permissionBearing).toBe(
      false,
    );
    expect(CRM_EDGE_TYPE_CATALOG.DOCUMENT_ABOUT_ENTITY.permissionBearing).toBe(false);
  });
});

describe("CRM Phase 4 exact relationship derivations", () => {
  it("starts with only the three relationships current source keys can prove", () => {
    expect(Object.keys(CRM_PHASE_4_DERIVATION_CATALOG).sort()).toEqual([
      "AOA_DEAL_HOUSEHOLD",
      "AOA_TRANSFER_HOUSEHOLD",
      "CRM_CONTACT_HOUSEHOLD",
    ]);
  });

  it("keeps every initial derivation non-permission-bearing and directionally typed", () => {
    for (const derivation of Object.values(CRM_PHASE_4_DERIVATION_CATALOG)) {
      const edge = CRM_EDGE_TYPE_CATALOG[derivation.edgeType];
      expect(edge.permissionBearing).toBe(false);
      expect(edge.fromTypes).toContain(derivation.from.identityType);
      expect(edge.toTypes).toContain(derivation.to.identityType);
      expect(derivation.keyMatch).toBe("SALESFORCE_15_OR_18_EXACT");
    }
  });

  it("uses the graph endpoint's internal source mapping as relationship evidence", () => {
    for (const derivation of Object.values(CRM_PHASE_4_DERIVATION_CATALOG)) {
      const evidence =
        derivation.evidenceEndpoint === "FROM" ? derivation.from : derivation.to;
      expect(CRM_ID_CATALOG[evidence.identityType].graphEndpoint).toBe(true);
      expect(evidence.sourceSystem).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(evidence.sourceNamespace).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("does not prematurely derive accounts, documents, third parties, or consent", () => {
    const derivations = Object.values(CRM_PHASE_4_DERIVATION_CATALOG);
    const endpointTypes = derivations.flatMap((entry) => [
      entry.from.identityType,
      entry.to.identityType,
    ]);
    const edgeTypes = derivations.map((entry) => entry.edgeType);

    expect(endpointTypes).not.toContain("ACCOUNT");
    expect(endpointTypes).not.toContain("DOCUMENT");
    expect(endpointTypes).not.toContain("THIRD_PARTY");
    expect(edgeTypes).not.toContain("PERSON_AUTHORIZES_PERSON");
    expect(edgeTypes).not.toContain("HOUSEHOLD_AUTHORIZES_THIRD_PARTY");
  });
});

describe("CRM synthetic privacy fixtures", () => {
  const entityIds = new Set(CRM_PRIVACY_FIXTURE_ENTITIES.map((entity) => entity.id));
  const edgeIds = new Set(CRM_PRIVACY_FIXTURE_EDGES.map((edge) => edge.id));

  it("uses unique typed IDs and graph-approved entity endpoints", () => {
    expect(entityIds.size).toBe(CRM_PRIVACY_FIXTURE_ENTITIES.length);

    for (const entity of CRM_PRIVACY_FIXTURE_ENTITIES) {
      expect(crmIdMatchesType(entity.type, entity.id)).toBe(true);
      expect(CRM_ID_CATALOG[entity.type].graphEndpoint).toBe(true);
    }
  });

  it("uses unique relationship IDs and references existing entities", () => {
    expect(edgeIds.size).toBe(CRM_PRIVACY_FIXTURE_EDGES.length);

    for (const edge of CRM_PRIVACY_FIXTURE_EDGES) {
      expect(crmIdMatchesType("RELATIONSHIP", edge.id)).toBe(true);
      expect(edge.type in CRM_EDGE_TYPE_CATALOG).toBe(true);
      expect(entityIds.has(edge.from)).toBe(true);
      expect(entityIds.has(edge.to)).toBe(true);

      const from = CRM_PRIVACY_FIXTURE_ENTITIES.find((entity) => entity.id === edge.from)!;
      const to = CRM_PRIVACY_FIXTURE_ENTITIES.find((entity) => entity.id === edge.to)!;
      const contract = CRM_EDGE_TYPE_CATALOG[edge.type];
      expect(contract.fromTypes).toContain(from.type);
      expect(contract.toTypes).toContain(to.type);
    }
  });

  it("keeps every scenario referentially complete and RLS fail-closed", () => {
    for (const scenario of CRM_PRIVACY_SCENARIOS) {
      expect(entityIds.has(scenario.principalId)).toBe(true);
      expect(entityIds.has(scenario.resourceId)).toBe(true);
      for (const edgeId of scenario.relevantEdgeIds) expect(edgeIds.has(edgeId)).toBe(true);
      if (!scenario.rlsVisible) expect(scenario.expectedDecision).toBe("DENY");
    }
  });

  it("contains no type values outside the reviewed ID catalog", () => {
    for (const entity of CRM_PRIVACY_FIXTURE_ENTITIES) {
      expect(entity.type in CRM_ID_CATALOG).toBe(true);
    }
    expect(Object.keys(CRM_ID_CATALOG) as CrmIdType[]).toContain("RELATIONSHIP");
  });
});
