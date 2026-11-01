// @vitest-environment node

import { describe, expect, it } from "vitest";
import config from "../../../demo-config.json";
import { DIRECTORY_QUERY_FINGERPRINT } from "./directory";

// demo-config.json is what the Worker hands the container and what the deploy loads before its reset.
describe("demo-config.json", () => {
  const settings = config as Record<string, string>;

  it("turns the demo on", () => {
    expect(settings).toMatchObject({
      NEXT_PUBLIC_DEMO_MODE: "on",
      PERSONA_SIGN_IN: "on",
      DEMO_STAND_INS: "on",
      AUTH_TRUST_HOST: "true",
      RATE_LIMIT_MEMORY_FALLBACK: "true",
    });
  });

  it("points every outside service at the stand-ins' own port", () => {
    const loopback = Object.entries(settings).filter(([, value]) => value.includes("127.0.0.1"));
    expect(loopback.map(([key]) => key).sort()).toEqual([
      "CLIENT_DIRECTORY_WAREHOUSE_URL", "FEE_STORE_DB_URL", "GCP_ASSET_MAPPING_URL",
    ]);
    for (const [, value] of loopback) expect(new URL(value).port).toBe(settings.STAND_INS_PORT);
    expect(settings.CLIENT_DIRECTORY_QUERY_FINGERPRINT).toBe(DIRECTORY_QUERY_FINGERPRINT);
  });

  it("holds no secrets (the Worker adds those, fresh or from the deploy's secrets)", () => {
    expect(Object.keys(settings).filter((key) => /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|WEBHOOK/.test(key))).toEqual([]);
  });
});
