import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  crmConsentEnabled,
  crmDocumentsEnabled,
  crmDocumentsPreviewEnabled,
  crmEbacEnforceEnabled,
  crmDuplicateDetectorWritesEnabled,
  crmIdentityReconciliationEnabled,
  crmIdentityReconciliationWritesEnabled,
  crmIdentityPostCommitSignalsEnabled,
  crmIdentityReadsEnabled,
  crmRelationshipReconciliationEnabled,
  crmRelationshipReconciliationWritesEnabled,
  crmRelationshipContinuousRefreshEnabled,
  crmRelationshipsEnabled,
  crmReportingEnabled,
} from "@/lib/flags";

const CRM_FLAGS = [
  ["CRM_IDENTITY_READS", crmIdentityReadsEnabled],
  ["CRM_IDENTITY_RECONCILIATION", crmIdentityReconciliationEnabled],
  ["CRM_IDENTITY_RECONCILIATION_WRITES", crmIdentityReconciliationWritesEnabled],
  ["CRM_DUPLICATE_DETECTOR_WRITES", crmDuplicateDetectorWritesEnabled],
  ["CRM_IDENTITY_POST_COMMIT_SIGNALS", crmIdentityPostCommitSignalsEnabled],
  ["CRM_RELATIONSHIP_RECONCILIATION", crmRelationshipReconciliationEnabled],
  ["CRM_RELATIONSHIP_RECONCILIATION_WRITES", crmRelationshipReconciliationWritesEnabled],
  ["CRM_RELATIONSHIP_CONTINUOUS_REFRESH", crmRelationshipContinuousRefreshEnabled],
  ["CRM_RELATIONSHIPS", crmRelationshipsEnabled],
  ["CRM_DOCUMENTS", crmDocumentsEnabled],
  ["CRM_CONSENT", crmConsentEnabled],
  ["CRM_EBAC_ENFORCE", crmEbacEnforceEnabled],
  ["CRM_REPORTING", crmReportingEnabled],
] as const;

describe.each(CRM_FLAGS)("%s", (key, enabled) => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[key];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });

  it('is enabled only by the exact string "1"', () => {
    process.env[key] = "1";
    expect(enabled()).toBe(true);
  });

  it("is off when unset", () => {
    delete process.env[key];
    expect(enabled()).toBe(false);
  });

  it("fails closed for every other representative value", () => {
    for (const value of ["", "0", "true", "TRUE", "yes", "on", "2", " 1"]) {
      process.env[key] = value;
      expect(enabled()).toBe(false);
    }
  });
});

describe("CRM flag independence", () => {
  const keys = CRM_FLAGS.map(([key]) => key);
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const prior = saved.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    saved.clear();
  });

  it("does not infer EBAC enforcement from read-only feature flags", () => {
    process.env.CRM_IDENTITY_READS = "1";
    process.env.CRM_RELATIONSHIPS = "1";
    process.env.CRM_CONSENT = "1";

    expect(crmIdentityReadsEnabled()).toBe(true);
    expect(crmRelationshipsEnabled()).toBe(true);
    expect(crmConsentEnabled()).toBe(true);
    expect(crmEbacEnforceEnabled()).toBe(false);
  });
});

describe("CRM dev preview gates", () => {
  const keys = ["APP_ENV", "CRM_DOCUMENTS"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const prior = saved.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    saved.clear();
  });

  it("enables the synthetic document surface only in the explicit dev environment", () => {
    process.env.APP_ENV = "dev";
    process.env.CRM_DOCUMENTS = "1";

    expect(crmDocumentsPreviewEnabled()).toBe(true);
  });

  it.each(["prod", "production", "staging", "", "DEV "])(
    "fails closed when APP_ENV is %j even if every raw flag is on",
    (appEnv) => {
      process.env.APP_ENV = appEnv;
      process.env.CRM_DOCUMENTS = "1";

      expect(crmDocumentsPreviewEnabled()).toBe(false);
    },
  );

  it("keeps the surface disabled when its raw flag is absent", () => {
    process.env.APP_ENV = "dev";
    expect(crmDocumentsPreviewEnabled()).toBe(false);
  });
});
