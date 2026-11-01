// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { custodianFeeScheduleMetadataOnlyEnabled } from "./custodian-authority-flags";

const EPIC = "EPIC_CUSTODIAN_DATABASE_AUTHORITY";
const CHILD = "ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY";

function clearFlags() {
  delete process.env[EPIC];
  delete process.env[CHILD];
}

afterEach(() => clearFlags());

describe("custodian fee schedule metadata-only flag", () => {
  it("both unset returns false", () => {
    clearFlags();
    expect(custodianFeeScheduleMetadataOnlyEnabled()).toBe(false);
  });

  it("only the epic var 1 returns false", () => {
    try {
      process.env[EPIC] = "1";
      delete process.env[CHILD];
      expect(custodianFeeScheduleMetadataOnlyEnabled()).toBe(false);
    } finally {
      clearFlags();
    }
  });

  it("only the child var 1 returns false", () => {
    try {
      delete process.env[EPIC];
      process.env[CHILD] = "1";
      expect(custodianFeeScheduleMetadataOnlyEnabled()).toBe(false);
    } finally {
      clearFlags();
    }
  });

  it("both 1 returns true", () => {
    try {
      process.env[EPIC] = "1";
      process.env[CHILD] = "1";
      expect(custodianFeeScheduleMetadataOnlyEnabled()).toBe(true);
    } finally {
      clearFlags();
    }
  });

  it("both true returns false", () => {
    try {
      process.env[EPIC] = "true";
      process.env[CHILD] = "true";
      expect(custodianFeeScheduleMetadataOnlyEnabled()).toBe(false);
    } finally {
      clearFlags();
    }
  });
});
