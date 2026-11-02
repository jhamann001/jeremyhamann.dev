/**
 * Phase 0 contracts for the additive CRM identity and relationship layer.
 *
 * This module is intentionally data-only. It does not create IDs, resolve
 * source rows, traverse relationships, authorize access, or read a database.
 * Later phases must build against these reviewed catalogs instead of inventing
 * prefixes or edge semantics at call sites.
 */

export type CrmIdKind = "ENTITY" | "RECORD" | "RELATIONSHIP";
export const CRM_CONTRACT_VERSION = 1 as const;

type CrmIdCatalogEntry = {
  prefix: string;
  kind: CrmIdKind;
  graphEndpoint: boolean;
  description: string;
};

export const CRM_ID_CATALOG = {
  HOUSEHOLD: {
    prefix: "hld",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "Household or family grouping",
  },
  CONTACT: {
    prefix: "con",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "Person or contact",
  },
  ACCOUNT: {
    prefix: "acc",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "Financial account across one or more source aliases",
  },
  DEAL: {
    prefix: "dea",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "AOA deal",
  },
  TRANSFER: {
    prefix: "xfr",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "AOA asset-transfer lifecycle",
  },
  TASK: {
    prefix: "tsk",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "Actionable task or workflow item",
  },
  DOCUMENT: {
    prefix: "doc",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "Document metadata and external pointer; never file bytes",
  },
  THIRD_PARTY: {
    prefix: "tpr",
    kind: "ENTITY",
    graphEndpoint: true,
    description: "CPA, attorney, trustee, or other external professional",
  },
  EMAIL: {
    prefix: "eml",
    kind: "RECORD",
    graphEndpoint: false,
    description: "Communication record linked to CRM entities",
  },
  ACTIVITY: {
    prefix: "act",
    kind: "RECORD",
    graphEndpoint: false,
    description: "Historical activity record linked to CRM entities",
  },
  APPOINTMENT: {
    prefix: "apt",
    kind: "RECORD",
    graphEndpoint: false,
    description: "Meeting or appointment record linked to participants",
  },
  RELATIONSHIP: {
    prefix: "rel",
    kind: "RELATIONSHIP",
    graphEndpoint: false,
    description: "Relationship or consent edge",
  },
} as const satisfies Record<string, CrmIdCatalogEntry>;

export type CrmIdType = keyof typeof CRM_ID_CATALOG;

export function crmIdPrefix(type: CrmIdType): string {
  return CRM_ID_CATALOG[type].prefix;
}

export function crmIdMatchesType(type: CrmIdType, value: string): boolean {
  const prefix = crmIdPrefix(type);
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}

export type CrmEdgeDirection = "DIRECTED" | "SYMMETRIC";

type CrmEdgeCatalogEntry = {
  direction: CrmEdgeDirection;
  fromTypes: readonly CrmIdType[];
  toTypes: readonly CrmIdType[];
  permissionBearing: boolean;
  revocable: boolean;
  description: string;
};

/**
 * A relationship is evidence, not authorization. Only entries explicitly
 * marked permissionBearing may participate in a future EBAC decision, and even
 * then existing RLS visibility remains the non-bypassable floor.
 */
export const CRM_EDGE_TYPE_CATALOG = {
  HOUSEHOLD_HAS_MEMBER: {
    direction: "DIRECTED",
    fromTypes: ["HOUSEHOLD"],
    toTypes: ["CONTACT"],
    permissionBearing: false,
    revocable: false,
    description: "Household includes a person",
  },
  HOUSEHOLD_OWNS_ACCOUNT: {
    direction: "DIRECTED",
    fromTypes: ["HOUSEHOLD"],
    toTypes: ["ACCOUNT"],
    permissionBearing: false,
    revocable: false,
    description: "Household owns or controls an account",
  },
  PERSON_OWNS_ACCOUNT: {
    direction: "DIRECTED",
    fromTypes: ["CONTACT"],
    toTypes: ["ACCOUNT"],
    permissionBearing: false,
    revocable: false,
    description: "Person is an owner of an account",
  },
  PERSON_PRIMARY_CONTACT_FOR_HOUSEHOLD: {
    direction: "DIRECTED",
    fromTypes: ["CONTACT"],
    toTypes: ["HOUSEHOLD"],
    permissionBearing: false,
    revocable: false,
    description: "Person is a household's primary contact",
  },
  DEAL_FOR_HOUSEHOLD: {
    direction: "DIRECTED",
    fromTypes: ["DEAL"],
    toTypes: ["HOUSEHOLD"],
    permissionBearing: false,
    revocable: false,
    description: "Deal belongs to a household",
  },
  TRANSFER_FOR_HOUSEHOLD: {
    direction: "DIRECTED",
    fromTypes: ["TRANSFER"],
    toTypes: ["HOUSEHOLD"],
    permissionBearing: false,
    revocable: false,
    description: "Transfer belongs to a household",
  },
  TRANSFER_FUNDS_ACCOUNT: {
    direction: "DIRECTED",
    fromTypes: ["TRANSFER"],
    toTypes: ["ACCOUNT"],
    permissionBearing: false,
    revocable: false,
    description: "Transfer funds or opens an account",
  },
  DOCUMENT_ABOUT_ENTITY: {
    direction: "DIRECTED",
    fromTypes: ["DOCUMENT"],
    toTypes: [
      "HOUSEHOLD",
      "CONTACT",
      "ACCOUNT",
      "DEAL",
      "TRANSFER",
      "TASK",
      "THIRD_PARTY",
    ],
    permissionBearing: false,
    revocable: false,
    description: "Document metadata concerns a registered entity",
  },
  THIRD_PARTY_SERVES_HOUSEHOLD: {
    direction: "DIRECTED",
    fromTypes: ["THIRD_PARTY"],
    toTypes: ["HOUSEHOLD"],
    permissionBearing: false,
    revocable: true,
    description: "Third party serves a household without itself granting access",
  },
  PERSON_AUTHORIZES_PERSON: {
    direction: "DIRECTED",
    fromTypes: ["CONTACT"],
    toTypes: ["CONTACT"],
    permissionBearing: true,
    revocable: true,
    description: "Scoped, evidenced, and revocable person-to-person authority",
  },
  HOUSEHOLD_AUTHORIZES_THIRD_PARTY: {
    direction: "DIRECTED",
    fromTypes: ["HOUSEHOLD"],
    toTypes: ["THIRD_PARTY"],
    permissionBearing: true,
    revocable: true,
    description: "Scoped, evidenced, and revocable third-party authority",
  },
} as const satisfies Record<string, CrmEdgeCatalogEntry>;

export type CrmEdgeType = keyof typeof CRM_EDGE_TYPE_CATALOG;

export type CrmRelationshipKeyMatch = "SALESFORCE_15_OR_18_EXACT";

type CrmRelationshipEndpointContract = {
  identityType: CrmIdType;
  sourceSystem: string;
  sourceNamespace: string;
};

type CrmRelationshipDerivationContract = {
  edgeType: CrmEdgeType;
  from: CrmRelationshipEndpointContract;
  to: CrmRelationshipEndpointContract;
  evidenceEndpoint: "FROM" | "TO";
  sourceRecord: string;
  parentPointer: string;
  keyMatch: CrmRelationshipKeyMatch;
  description: string;
};

/**
 * Phase 4 starts with the exact relationships that the current identity
 * registry and source rows can prove. This catalog is intentionally smaller
 * than CRM_EDGE_TYPE_CATALOG: account, document, primary-contact, third-party,
 * and consent edges remain unavailable until their source contracts exist.
 *
 * The evidence endpoint identifies the crm_source_mapping row that caused the
 * relationship to exist. Relationship storage must reference that internal
 * mapping id; it must not duplicate an external source key into an audited
 * edge row.
 */
export const CRM_PHASE_4_DERIVATION_CATALOG = {
  CRM_CONTACT_HOUSEHOLD: {
    edgeType: "HOUSEHOLD_HAS_MEMBER",
    from: {
      identityType: "HOUSEHOLD",
      sourceSystem: "CRM",
      sourceNamespace: "household",
    },
    to: {
      identityType: "CONTACT",
      sourceSystem: "CRM",
      sourceNamespace: "contact",
    },
    evidenceEndpoint: "TO",
    sourceRecord: "mirror.client",
    parentPointer: "household_id",
    keyMatch: "SALESFORCE_15_OR_18_EXACT",
    description: "A CRM contact is an exact member of its parent household",
  },
  AOA_DEAL_HOUSEHOLD: {
    edgeType: "DEAL_FOR_HOUSEHOLD",
    from: {
      identityType: "DEAL",
      sourceSystem: "AOA",
      sourceNamespace: "deal",
    },
    to: {
      identityType: "HOUSEHOLD",
      sourceSystem: "CRM",
      sourceNamespace: "household",
    },
    evidenceEndpoint: "FROM",
    sourceRecord: "app.deal",
    parentPointer: "household_sf_id",
    keyMatch: "SALESFORCE_15_OR_18_EXACT",
    description: "An AOA deal points to an exact CRM household",
  },
  AOA_TRANSFER_HOUSEHOLD: {
    edgeType: "TRANSFER_FOR_HOUSEHOLD",
    from: {
      identityType: "TRANSFER",
      sourceSystem: "AOA",
      sourceNamespace: "transfer",
    },
    to: {
      identityType: "HOUSEHOLD",
      sourceSystem: "CRM",
      sourceNamespace: "household",
    },
    evidenceEndpoint: "FROM",
    sourceRecord: "app.transfer",
    parentPointer: "household_sf_id",
    keyMatch: "SALESFORCE_15_OR_18_EXACT",
    description: "An AOA transfer points to an exact CRM household",
  },
} as const satisfies Record<string, CrmRelationshipDerivationContract>;

export type CrmPhase4Derivation = keyof typeof CRM_PHASE_4_DERIVATION_CATALOG;
