import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  transferDealSourcedRedesignEnabled,
  hideDemoTransferCardsEnabled,
  slackCloseoutEnabled,
  transferArchiveActionEnabled,
  aiMeetingPrepEnabled,
  commandCenterFunnelLiveEnabled,
  commandCenterMeetingsLiveEnabled,
  clientPortraitExperimentsEnabled,
  clientPortraitTradeProfileLiveEnabled,
  operationsToolsEnabled,
  operationsFeeRequestsPreviewEnabled,
  operationsTradeReconciliationPreviewEnabled,
  assetMapRunIdentityEnabled,
  assetMapRunIdentityWritesEnabled,
  assetMappingReadEnabled,
  assetMappingEditsEnabled,
  assetMappingClientLinkingEnabled,
  assetMappingDestinationsEnabled,
  assetMappingDocumentsEnabled,
  assetMappingWorkspaceEnabled,
  assetMappingOnDemandImportEnabled,
  acatCustodianAdminEnabled,
  custodianAdminAllowed,
  epicCustodianDatabaseAuthorityEnabled,
  showCustodianAuthorityLibraryEnabled,
  acatFeeReimbursementEnabled,
  acatFeeRequestCreateEnabled,
  epicAcatFeeReimbursementEnabled,
  epicPlaidLinkedHoldingsEnabled,
  showPlaidLinkedAccountSummariesEnabled,
} from "@/lib/flags";
import { markCase } from "./acat-book-flywheel";

describe.each([
  ["ASSET_MAP_RUN_IDENTITY_ENABLED", assetMapRunIdentityEnabled],
  ["ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED", assetMapRunIdentityWritesEnabled],
] as const)("%s (ticket)", (key, flag) => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[key];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });

  it("defaults off when unset", () => {
    delete process.env[key];
    expect(flag()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    process.env[key] = "1";
    expect(flag()).toBe(true);
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "2", " 1", "1 "]) {
      process.env[key] = v;
      expect(flag()).toBe(false);
    }
  });
});

// The env-var feature flag (ticket §1 item 5): only "1" is ON; everything
// else — unset, "", "0", "true", any other string — is OFF (default off).

describe("transferDealSourcedRedesignEnabled", () => {
  const KEY = "TRANSFER_DEAL_SOURCED_REDESIGN";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true only for exactly "1"', () => {
    process.env[KEY] = "1";
    expect(transferDealSourcedRedesignEnabled()).toBe(true);
  });

  it("is false when unset", () => {
    delete process.env[KEY];
    expect(transferDealSourcedRedesignEnabled()).toBe(false);
  });

  it('is false for "" / "0" / "true" / other values', () => {
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "2"]) {
      process.env[KEY] = v;
      expect(transferDealSourcedRedesignEnabled()).toBe(false);
    }
  });
});

describe("hideDemoTransferCardsEnabled", () => {
  const KEY = "HIDE_DEMO_TRANSFER_CARDS";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true only for exactly "1"', () => {
    process.env[KEY] = "1";
    expect(hideDemoTransferCardsEnabled()).toBe(true);
  });

  it("is false when unset", () => {
    delete process.env[KEY];
    expect(hideDemoTransferCardsEnabled()).toBe(false);
  });

  it("fails closed for every other value", () => {
    for (const value of ["", "0", "true", "TRUE", "yes", "on", "2"]) {
      process.env[KEY] = value;
      expect(hideDemoTransferCardsEnabled()).toBe(false);
    }
  });
});

describe("slackCloseoutEnabled", () => {
  const KEY = "SLACK_TRANSFER_CLOSEOUT";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true only for exactly "1"', () => {
    process.env[KEY] = "1";
    expect(slackCloseoutEnabled()).toBe(true);
  });

  it("is false when unset", () => {
    delete process.env[KEY];
    expect(slackCloseoutEnabled()).toBe(false);
  });

  it('is false for "" / "0" / "true" / other values', () => {
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "2"]) {
      process.env[KEY] = v;
      expect(slackCloseoutEnabled()).toBe(false);
    }
  });
});

describe("transferArchiveActionEnabled", () => {
  const KEY = "TRANSFER_ARCHIVE_ACTION";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true only for exactly "1"', () => {
    process.env[KEY] = "1";
    expect(transferArchiveActionEnabled()).toBe(true);
  });

  it("is false when unset (ships dark)", () => {
    delete process.env[KEY];
    expect(transferArchiveActionEnabled()).toBe(false);
  });

  it('is false for "" / "0" / "true" / other values', () => {
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "2"]) {
      process.env[KEY] = v;
      expect(transferArchiveActionEnabled()).toBe(false);
    }
  });
});

describe("aiMeetingPrepEnabled", () => {
  const KEY = "AI_MEETING_PREP";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true only for exactly "1"', () => {
    process.env[KEY] = "1";
    expect(aiMeetingPrepEnabled()).toBe(true);
  });

  it("is false when unset (ships dark — no UI affordance, no writes, no Vertex)", () => {
    delete process.env[KEY];
    expect(aiMeetingPrepEnabled()).toBe(false);
  });

  it('is false for "" / "0" / "true" / other values', () => {
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "2"]) {
      process.env[KEY] = v;
      expect(aiMeetingPrepEnabled()).toBe(false);
    }
  });

  it("is INDEPENDENT of AI_DRAFTING (blueprint ADR-5)", () => {
    const savedDrafting = process.env.AI_DRAFTING;
    try {
      process.env.AI_DRAFTING = "1";
      delete process.env[KEY];
      expect(aiMeetingPrepEnabled()).toBe(false);
    } finally {
      if (savedDrafting === undefined) delete process.env.AI_DRAFTING;
      else process.env.AI_DRAFTING = savedDrafting;
    }
  });
});

describe("clientPortraitExperimentsEnabled", () => {
  const FLAG = "CLIENT_PORTRAIT_EXPERIMENTS";
  const APP_ENV = "APP_ENV";
  let savedFlag: string | undefined;
  let savedAppEnv: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG];
    savedAppEnv = process.env[APP_ENV];
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    if (savedAppEnv === undefined) delete process.env[APP_ENV];
    else process.env[APP_ENV] = savedAppEnv;
  });

  it("is enabled only by the exact flag in the dev environment", () => {
    process.env[APP_ENV] = "dev";
    process.env[FLAG] = "1";
    expect(clientPortraitExperimentsEnabled()).toBe(true);
  });

  it("fails closed outside dev even when the flag is on", () => {
    process.env[FLAG] = "1";
    for (const environment of ["", "prod", "production", "staging"]) {
      process.env[APP_ENV] = environment;
      expect(clientPortraitExperimentsEnabled()).toBe(false);
    }
  });

  it("fails closed in dev for every non-exact flag value", () => {
    process.env[APP_ENV] = "dev";
    for (const value of ["", "0", "true", "yes", "on", "2"]) {
      process.env[FLAG] = value;
      expect(clientPortraitExperimentsEnabled()).toBe(false);
    }
  });
});

describe("clientPortraitTradeProfileLiveEnabled", () => {
  const KEY = "CLIENT_PORTRAIT_TRADE_PROFILE_LIVE";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is enabled only by the exact value "1"', () => {
    process.env[KEY] = "1";
    expect(clientPortraitTradeProfileLiveEnabled()).toBe(true);

    for (const value of ["", "0", "true", "yes", "2"]) {
      process.env[KEY] = value;
      expect(clientPortraitTradeProfileLiveEnabled()).toBe(false);
    }
  });

  it("is disabled when unset", () => {
    delete process.env[KEY];
    expect(clientPortraitTradeProfileLiveEnabled()).toBe(false);
  });
});

describe("operations tool rollout flags", () => {
  const keys = ["APP_ENV", "OPERATIONS_PRODUCTION_ENABLED", "OPERATIONS_TOOLS", "OPERATIONS_TRADE_RECONCILIATION", "OPERATIONS_FEE_REQUESTS"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const enableTools = () => {
    process.env.OPERATIONS_TOOLS = "1";
    process.env.OPERATIONS_TRADE_RECONCILIATION = "1";
    process.env.OPERATIONS_FEE_REQUESTS = "1";
  };

  it("preserves explicit dev behavior with parent and separate child switches", () => {
    process.env.APP_ENV = "dev";
    enableTools();
    expect(operationsToolsEnabled()).toBe(true);
    expect(operationsTradeReconciliationPreviewEnabled()).toBe(true);
    expect(operationsFeeRequestsPreviewEnabled()).toBe(true);
    process.env.OPERATIONS_FEE_REQUESTS = "0";
    expect(operationsFeeRequestsPreviewEnabled()).toBe(false);
    expect(operationsTradeReconciliationPreviewEnabled()).toBe(true);
    process.env.OPERATIONS_TRADE_RECONCILIATION = "0";
    expect(operationsTradeReconciliationPreviewEnabled()).toBe(false);
  });

  it.each(["", "0", "true", "yes", "2", undefined])(
    "requires the exact parent value 1 (%s)", (value) => {
      process.env.APP_ENV = "dev";
      enableTools();
      if (value === undefined) delete process.env.OPERATIONS_TOOLS;
      else process.env.OPERATIONS_TOOLS = value;
      expect(operationsToolsEnabled()).toBe(false);
      expect(operationsTradeReconciliationPreviewEnabled()).toBe(false);
      expect(operationsFeeRequestsPreviewEnabled()).toBe(false);
    },
  );

  it.each(["", "0", "true", "yes", "2", undefined])(
    "keeps production off without explicit enablement (%s)", (value) => {
      process.env.APP_ENV = "prod";
      enableTools();
      if (value !== undefined) process.env.OPERATIONS_PRODUCTION_ENABLED = value;
      expect(operationsToolsEnabled()).toBe(false);
      expect(operationsTradeReconciliationPreviewEnabled()).toBe(false);
      expect(operationsFeeRequestsPreviewEnabled()).toBe(false);
    },
  );

  it("enables only selected production tools after explicit approval", () => {
    process.env.APP_ENV = "prod";
    process.env.OPERATIONS_PRODUCTION_ENABLED = "1";
    process.env.OPERATIONS_TOOLS = "1";
    expect(operationsToolsEnabled()).toBe(true);
    expect(operationsTradeReconciliationPreviewEnabled()).toBe(false);
    expect(operationsFeeRequestsPreviewEnabled()).toBe(false);
    process.env.OPERATIONS_TRADE_RECONCILIATION = "1";
    expect(operationsTradeReconciliationPreviewEnabled()).toBe(true);
    process.env.OPERATIONS_FEE_REQUESTS = "1";
    expect(operationsFeeRequestsPreviewEnabled()).toBe(true);
    process.env.OPERATIONS_TOOLS = "0";
    expect(operationsTradeReconciliationPreviewEnabled()).toBe(false);
    expect(operationsFeeRequestsPreviewEnabled()).toBe(false);
  });

  it.each(["", "production", "staging", undefined])(
    "fails closed for unknown or missing APP_ENV (%s)", (appEnv) => {
      if (appEnv !== undefined) process.env.APP_ENV = appEnv;
      process.env.OPERATIONS_PRODUCTION_ENABLED = "1";
      enableTools();
      expect(operationsToolsEnabled()).toBe(false);
      expect(operationsTradeReconciliationPreviewEnabled()).toBe(false);
      expect(operationsFeeRequestsPreviewEnabled()).toBe(false);
    },
  );
});

describe("commandCenterFunnelLiveEnabled", () => {
  const KEY = "COMMAND_CENTER_FUNNEL_LIVE";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('is true only for exactly "1"', () => {
    process.env[KEY] = "1";
    expect(commandCenterFunnelLiveEnabled()).toBe(true);
  });

  it("is false when unset (the mock fixture keeps rendering)", () => {
    delete process.env[KEY];
    expect(commandCenterFunnelLiveEnabled()).toBe(false);
  });

  it('is false for "" / "0" / "true" / other values', () => {
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "2"]) {
      process.env[KEY] = v;
      expect(commandCenterFunnelLiveEnabled()).toBe(false);
    }
  });

  it("is INDEPENDENT of COMMAND_CENTER_MEETINGS_LIVE (different data sources)", () => {
    const savedMeetings = process.env.COMMAND_CENTER_MEETINGS_LIVE;
    try {
      process.env.COMMAND_CENTER_MEETINGS_LIVE = "1";
      delete process.env[KEY];
      expect(commandCenterFunnelLiveEnabled()).toBe(false);
      expect(commandCenterMeetingsLiveEnabled()).toBe(true);
    } finally {
      if (savedMeetings === undefined) delete process.env.COMMAND_CENTER_MEETINGS_LIVE;
      else process.env.COMMAND_CENTER_MEETINGS_LIVE = savedMeetings;
    }
  });
});

describe("EPIC_AOA_ASSET_MAPPING_READ (ticket)", () => {
  const KEY = "EPIC_AOA_ASSET_MAPPING_READ";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("defaults off when unset", () => {
    delete process.env[KEY];
    expect(assetMappingReadEnabled()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env[KEY] = v;
      expect(assetMappingReadEnabled()).toBe(false);
    }
    process.env[KEY] = "1";
    expect(assetMappingReadEnabled()).toBe(true);
  });
});

describe("EPIC_AOA_ASSET_MAPPING_EDITS (ticket)", () => {
  const KEYS = ["EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_EDITS"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env.EPIC_AOA_ASSET_MAPPING_READ = "1";
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults off when unset", () => {
    delete process.env.EPIC_AOA_ASSET_MAPPING_EDITS;
    expect(assetMappingEditsEnabled()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env.EPIC_AOA_ASSET_MAPPING_EDITS = v;
      expect(assetMappingEditsEnabled()).toBe(false);
    }
    process.env.EPIC_AOA_ASSET_MAPPING_EDITS = "1";
    expect(assetMappingEditsEnabled()).toBe(true);
  });

  it("stays off while the read flag is off", () => {
    process.env.EPIC_AOA_ASSET_MAPPING_EDITS = "1";
    delete process.env.EPIC_AOA_ASSET_MAPPING_READ;
    expect(assetMappingEditsEnabled()).toBe(false);
  });
});

describe("EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING (ticket)", () => {
  const KEYS = ["EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env.EPIC_AOA_ASSET_MAPPING_READ = "1";
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults off when unset", () => {
    delete process.env.EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING;
    expect(assetMappingClientLinkingEnabled()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env.EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING = v;
      expect(assetMappingClientLinkingEnabled()).toBe(false);
    }
    process.env.EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING = "1";
    expect(assetMappingClientLinkingEnabled()).toBe(true);
  });

  it("stays off while the read flag is off", () => {
    process.env.EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING = "1";
    delete process.env.EPIC_AOA_ASSET_MAPPING_READ;
    expect(assetMappingClientLinkingEnabled()).toBe(false);
  });
});

describe("EPIC_AOA_ASSET_MAPPING_DESTINATIONS (ticket)", () => {
  const KEYS = ["EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_DESTINATIONS"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env.EPIC_AOA_ASSET_MAPPING_READ = "1";
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults off when unset", () => {
    delete process.env.EPIC_AOA_ASSET_MAPPING_DESTINATIONS;
    expect(assetMappingDestinationsEnabled()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env.EPIC_AOA_ASSET_MAPPING_DESTINATIONS = v;
      expect(assetMappingDestinationsEnabled()).toBe(false);
    }
    process.env.EPIC_AOA_ASSET_MAPPING_DESTINATIONS = "1";
    expect(assetMappingDestinationsEnabled()).toBe(true);
  });

  it("stays off while the read flag is off", () => {
    process.env.EPIC_AOA_ASSET_MAPPING_DESTINATIONS = "1";
    delete process.env.EPIC_AOA_ASSET_MAPPING_READ;
    expect(assetMappingDestinationsEnabled()).toBe(false);
  });
});

describe("EPIC_AOA_ASSET_MAPPING_DOCUMENTS (ticket)", () => {
  const KEYS = ["EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_DOCUMENTS"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    process.env.EPIC_AOA_ASSET_MAPPING_READ = "1";
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults off when unset", () => {
    delete process.env.EPIC_AOA_ASSET_MAPPING_DOCUMENTS;
    expect(assetMappingDocumentsEnabled()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env.EPIC_AOA_ASSET_MAPPING_DOCUMENTS = v;
      expect(assetMappingDocumentsEnabled()).toBe(false);
    }
    process.env.EPIC_AOA_ASSET_MAPPING_DOCUMENTS = "1";
    expect(assetMappingDocumentsEnabled()).toBe(true);
  });

  it("stays off while the read flag is off", () => {
    process.env.EPIC_AOA_ASSET_MAPPING_DOCUMENTS = "1";
    delete process.env.EPIC_AOA_ASSET_MAPPING_READ;
    expect(assetMappingDocumentsEnabled()).toBe(false);
  });
});

describe("EPIC_AOA_ASSET_MAPPING_WORKSPACE (ticket)", () => {
  const KEYS = ["EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_WORKSPACE"] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults off when unset, even while the read flag is on", () => {
    process.env.EPIC_AOA_ASSET_MAPPING_READ = "1";
    delete process.env.EPIC_AOA_ASSET_MAPPING_WORKSPACE;
    expect(assetMappingWorkspaceEnabled()).toBe(false);
  });

  it('enables only for exactly "1"', () => {
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env.EPIC_AOA_ASSET_MAPPING_WORKSPACE = v;
      expect(assetMappingWorkspaceEnabled()).toBe(false);
    }
    process.env.EPIC_AOA_ASSET_MAPPING_WORKSPACE = "1";
    expect(assetMappingWorkspaceEnabled()).toBe(true);
  });

  it("does not depend on the read flag", () => {
    process.env.EPIC_AOA_ASSET_MAPPING_WORKSPACE = "1";
    delete process.env.EPIC_AOA_ASSET_MAPPING_READ;
    expect(assetMappingWorkspaceEnabled()).toBe(true);
  });
});

describe("assetMappingOnDemandImportEnabled (ticket)", () => {
  const KEYS = [
    "EPIC_AOA_ASSET_MAPPING_ON_DEMAND_IMPORT", "EPIC_AOA_ASSET_MAPPING_READ", "EPIC_AOA_ASSET_MAPPING_EDITS",
    "EPIC_AOA_ASSET_MAPPING_DESTINATIONS", "EPIC_AOA_ASSET_MAPPING_CLIENT_LINKING", "EPIC_AOA_ASSET_MAPPING_DOCUMENTS",
    "EPIC_AOA_ASSET_MAPPING_WORKSPACE",
  ] as const;
  let saved: (string | undefined)[] = [];
  beforeEach(() => {
    saved = KEYS.map((k) => process.env[k]);
    KEYS.forEach((k) => delete process.env[k]);
  });
  afterEach(() => {
    KEYS.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  it('enables only for exactly "1"; unset is off', () => {
    expect(assetMappingOnDemandImportEnabled()).toBe(false);
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      process.env.EPIC_AOA_ASSET_MAPPING_ON_DEMAND_IMPORT = v;
      expect(assetMappingOnDemandImportEnabled()).toBe(false);
    }
    process.env.EPIC_AOA_ASSET_MAPPING_ON_DEMAND_IMPORT = "1";
    expect(assetMappingOnDemandImportEnabled()).toBe(true);
  });

  it("is independent of every other asset-mapping flag", () => {
    KEYS.slice(1).forEach((k) => (process.env[k] = "1"));
    expect(assetMappingOnDemandImportEnabled()).toBe(false);
    KEYS.slice(1).forEach((k) => delete process.env[k]);
    process.env.EPIC_AOA_ASSET_MAPPING_ON_DEMAND_IMPORT = "1";
    expect(assetMappingOnDemandImportEnabled()).toBe(true);
  });
});

describe("custodian administration switches (ticket)", () => {
  const KEYS = ["EPIC_ACAT_CUSTODIAN_ADMIN_TKT323", "SHOW_ACAT_CUSTODIAN_ADMIN_TKT337"] as const;
  let saved: Array<string | undefined>;
  beforeEach(() => { saved = KEYS.map((k) => process.env[k]); KEYS.forEach((k) => delete process.env[k]); });
  afterEach(() => KEYS.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  }));

  it("custodian admin is off unless both switches are exactly 1", () => {
    expect(acatCustodianAdminEnabled()).toBe(false);
    process.env.EPIC_ACAT_CUSTODIAN_ADMIN_TKT323 = "1";
    expect(acatCustodianAdminEnabled()).toBe(false);
    for (const v of ["", "0", "true", " 1", "1 "]) {
      process.env.SHOW_ACAT_CUSTODIAN_ADMIN_TKT337 = v;
      expect(acatCustodianAdminEnabled()).toBe(false);
    }
    delete process.env.EPIC_ACAT_CUSTODIAN_ADMIN_TKT323;
    process.env.SHOW_ACAT_CUSTODIAN_ADMIN_TKT337 = "1";
    expect(acatCustodianAdminEnabled()).toBe(false);
    expect(custodianAdminAllowed("ADMIN")).toBe(false);
    markCase("flags", "custodian admin is off unless both switches are exactly 1");
  });

  it("custodian admin is on when both switches are 1", () => {
    process.env.EPIC_ACAT_CUSTODIAN_ADMIN_TKT323 = "1";
    process.env.SHOW_ACAT_CUSTODIAN_ADMIN_TKT337 = "1";
    expect(acatCustodianAdminEnabled()).toBe(true);
    expect(custodianAdminAllowed("ADMIN")).toBe(true);
    for (const role of ["OPERATIONS", "ADVISOR", "VIEWER", null, undefined]) {
      expect(custodianAdminAllowed(role)).toBe(false);
    }
    markCase("flags", "custodian admin is on when both switches are 1");
  });
});

describe("custodian authority library switches (ticket)", () => {
  const KEYS = ["EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397", "SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400"] as const;
  let saved: Array<string | undefined>;
  beforeEach(() => { saved = KEYS.map((k) => process.env[k]); KEYS.forEach((k) => delete process.env[k]); });
  afterEach(() => KEYS.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  }));

  it("authority library read is off unless both custodian authority switches are exactly 1", () => {
    expect(showCustodianAuthorityLibraryEnabled()).toBe(false);
    process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397 = "1";
    expect(epicCustodianDatabaseAuthorityEnabled()).toBe(true);
    expect(showCustodianAuthorityLibraryEnabled()).toBe(false);
    for (const v of ["", "0", "true", " 1", "1 "]) {
      process.env.SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400 = v;
      expect(showCustodianAuthorityLibraryEnabled()).toBe(false);
    }
    delete process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397;
    process.env.SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400 = "1";
    expect(epicCustodianDatabaseAuthorityEnabled()).toBe(false);
    expect(showCustodianAuthorityLibraryEnabled()).toBe(false);
    markCase("flags", "authority library read is off unless both custodian authority switches are exactly 1");
  });

  it("authority library read is on only when both custodian authority switches are exactly 1", () => {
    process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397 = "1";
    process.env.SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400 = "1";
    expect(epicCustodianDatabaseAuthorityEnabled()).toBe(true);
    expect(showCustodianAuthorityLibraryEnabled()).toBe(true);
    for (const v of ["", "0", "true", " 1", "1 "]) {
      process.env.SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400 = v;
      expect(showCustodianAuthorityLibraryEnabled()).toBe(false);
    }
    process.env.SHOW_CUSTODIAN_AUTHORITY_LIBRARY_TKT400 = "1";
    for (const v of ["", "0", "true", " 1", "1 "]) {
      process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY_TKT397 = v;
      expect(showCustodianAuthorityLibraryEnabled()).toBe(false);
    }
    markCase("flags", "authority library read is on only when both custodian authority switches are exactly 1");
  });
});

describe("fee reimbursement switches (ticket)", () => {
  const EPIC = "EPIC_ACAT_FEE_REIMBURSEMENT_TKT318";
  const SHOW = "SHOW_ACAT_FEE_REIMBURSEMENT_TKT333";
  let before: [string | undefined, string | undefined] = [undefined, undefined];
  beforeEach(() => { before = [process.env[EPIC], process.env[SHOW]]; delete process.env[EPIC]; delete process.env[SHOW]; });
  afterEach(() => {
    if (before[0] === undefined) delete process.env[EPIC]; else process.env[EPIC] = before[0];
    if (before[1] === undefined) delete process.env[SHOW]; else process.env[SHOW] = before[1];
  });

  it("fee reimbursement needs both switches exactly 1", () => {
    expect(acatFeeReimbursementEnabled()).toBe(false);
    process.env[EPIC] = "1";
    expect(epicAcatFeeReimbursementEnabled()).toBe(true);
    expect(acatFeeReimbursementEnabled()).toBe(false);
    delete process.env[EPIC];
    process.env[SHOW] = "1";
    expect(epicAcatFeeReimbursementEnabled()).toBe(false);
    expect(acatFeeReimbursementEnabled()).toBe(false);
    process.env[EPIC] = "1";
    expect(acatFeeReimbursementEnabled()).toBe(true);
    for (const value of ["true", "0", "", " 1", "1 "]) {
      process.env[SHOW] = value;
      expect(acatFeeReimbursementEnabled()).toBe(false);
    }
    process.env[SHOW] = "1";
    process.env[EPIC] = "true";
    expect(acatFeeReimbursementEnabled()).toBe(false);
    markCase("flags-fee", "fee reimbursement needs both switches exactly 1");
  });
});

describe("fee request create switch (ticket)", () => {
  const KEYS = ["EPIC_ACAT_FEE_REIMBURSEMENT_TKT318", "SHOW_ACAT_FEE_REIMBURSEMENT_TKT333", "SHOW_ACAT_FEE_REQUEST_CREATE_TKT350"] as const;
  let before: Array<string | undefined> = [];
  beforeEach(() => { before = KEYS.map((key) => process.env[key]); for (const key of KEYS) delete process.env[key]; });
  afterEach(() => {
    KEYS.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  });

  it("the preview-and-confirm flow needs the fee release and its own switch, each exactly 1", () => {
    const [EPIC, FEE, CREATE] = KEYS;
    expect(acatFeeRequestCreateEnabled()).toBe(false);
    process.env[CREATE] = "1";
    expect(acatFeeRequestCreateEnabled()).toBe(false);
    process.env[EPIC] = "1";
    expect(acatFeeRequestCreateEnabled()).toBe(false);
    process.env[FEE] = "1";
    expect(acatFeeRequestCreateEnabled()).toBe(true);
    for (const value of ["true", "0", "", " 1", "1 "]) {
      process.env[CREATE] = value;
      expect(acatFeeRequestCreateEnabled(), JSON.stringify(value)).toBe(false);
    }
    process.env[CREATE] = "1";
    delete process.env[FEE];
    expect(acatFeeRequestCreateEnabled()).toBe(false);
    markCase("flags-fee-create", "the preview-and-confirm flow needs the fee release and its own switch, each exactly 1");
  });
});

describe("Plaid-linked account summary switches (ticket)", () => {
  const EPIC = "EPIC_PLAID_LINKED_HOLDINGS";
  const SHOW = "SHOW_PLAID_LINKED_ACCOUNT_SUMMARIES";
  let before: [string | undefined, string | undefined] = [undefined, undefined];
  beforeEach(() => { before = [process.env[EPIC], process.env[SHOW]]; delete process.env[EPIC]; delete process.env[SHOW]; });
  afterEach(() => {
    if (before[0] === undefined) delete process.env[EPIC]; else process.env[EPIC] = before[0];
    if (before[1] === undefined) delete process.env[SHOW]; else process.env[SHOW] = before[1];
  });

  it("summaries need the epic and the surface switch exactly 1", () => {
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    process.env[EPIC] = "1";
    expect(epicPlaidLinkedHoldingsEnabled()).toBe(true);
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    delete process.env[EPIC];
    process.env[SHOW] = "1";
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
    process.env[EPIC] = "1";
    expect(showPlaidLinkedAccountSummariesEnabled()).toBe(true);
    for (const value of ["true", "0", "", " 1", "1 "]) {
      process.env[SHOW] = value;
      expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
      process.env[SHOW] = "1";
      process.env[EPIC] = value;
      expect(epicPlaidLinkedHoldingsEnabled()).toBe(false);
      expect(showPlaidLinkedAccountSummariesEnabled()).toBe(false);
      process.env[EPIC] = "1";
    }
  });
});
