import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_PERSONAS,
  DEV_PROVIDER_ID,
  assertDevLoginNotInProduction,
  findDevPersona,
  isDevLoginEnabled,
  isPersonaUserId,
} from "@/lib/dev-login";
import { loadUniverse } from "@/lib/demo/universe";

describe("the demo personas", () => {
  it("are universe staff, with the id and address the seed gives them (prisma/seed-dev.ts)", () => {
    const staff = loadUniverse().staff;
    for (const p of DEV_PERSONAS) {
      const person = staff.find((s) => s.name === p.name);
      expect(person, p.name).toBeDefined();
      expect(p.id).toBe(`staff_${person!.id.split("-")[0]}`);
      expect(p.email).toBe(`${p.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`);
    }
  });
});

type Stub = string | undefined;

function stub(nodeEnv: Stub, appEnv: Stub, devLogin: Stub): void {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("APP_ENV", appEnv);
  vi.stubEnv("AUTH_DEV_LOGIN", devLogin);
}

describe("dev-login kill switch (I6, Decision #57) — NODE_ENV × APP_ENV × AUTH_DEV_LOGIN", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const NODE_ENVS: Stub[] = ["production", "development", "test", undefined];

  it("APP_ENV=production + AUTH_DEV_LOGIN=true → disabled and the boot assertion throws, whatever NODE_ENV says", () => {
    for (const nodeEnv of NODE_ENVS) {
      stub(nodeEnv, "production", "true");
      expect(isDevLoginEnabled(), `NODE_ENV=${nodeEnv}`).toBe(false);
      expect(() => assertDevLoginNotInProduction(), `NODE_ENV=${nodeEnv}`).toThrowError(
        "AUTH_DEV_LOGIN must not be enabled in production",
      );
    }
  });

  it("APP_ENV=production + AUTH_DEV_LOGIN false / unset / wrong case → disabled, assertion passes", () => {
    for (const nodeEnv of NODE_ENVS) {
      for (const devLogin of ["false", undefined, "TRUE", "1", ""] as Stub[]) {
        stub(nodeEnv, "production", devLogin);
        expect(isDevLoginEnabled(), `NODE_ENV=${nodeEnv} AUTH_DEV_LOGIN=${devLogin}`).toBe(false);
        expect(() => assertDevLoginNotInProduction()).not.toThrow();
      }
    }
  });

  it("the deployed dev instance: NODE_ENV=production + APP_ENV=dev + AUTH_DEV_LOGIN=true → ENABLED, assertion passes (Decision #57)", () => {
    // Cloud Run runs every image with NODE_ENV=production; the environment label is APP_ENV, which Terraform
    // pins to "dev" on the dev service and to "production" on the production service.
    stub("production", "dev", "true");
    expect(isDevLoginEnabled()).toBe(true);
    expect(() => assertDevLoginNotInProduction()).not.toThrow();
  });

  it("NODE_ENV=production + APP_ENV unset (local) + AUTH_DEV_LOGIN=true → enabled (a local `next start` smoke)", () => {
    stub("production", undefined, "true");
    expect(isDevLoginEnabled()).toBe(true);
    expect(() => assertDevLoginNotInProduction()).not.toThrow();
    stub("production", "local", "true");
    expect(isDevLoginEnabled()).toBe(true);
  });

  it("NODE_ENV=production + non-production label + AUTH_DEV_LOGIN false / unset → disabled", () => {
    for (const appEnv of ["dev", "local", undefined] as Stub[]) {
      stub("production", appEnv, "false");
      expect(isDevLoginEnabled()).toBe(false);
      stub("production", appEnv, undefined);
      expect(isDevLoginEnabled()).toBe(false);
    }
  });

  it("development + AUTH_DEV_LOGIN=true → enabled for local and dev labels", () => {
    for (const appEnv of ["local", "dev", undefined] as Stub[]) {
      stub("development", appEnv, "true");
      expect(isDevLoginEnabled(), `APP_ENV=${appEnv}`).toBe(true);
      expect(() => assertDevLoginNotInProduction()).not.toThrow();
    }
  });

  it("development + AUTH_DEV_LOGIN=false → disabled", () => {
    stub("development", "local", "false");
    expect(isDevLoginEnabled()).toBe(false);
  });

  it("development + AUTH_DEV_LOGIN unset → disabled (the literal string true is required)", () => {
    stub("development", "local", undefined);
    expect(isDevLoginEnabled()).toBe(false);
  });

  it("wrong case / OPS_PORTAL's \"1\" / \"yes\" → disabled in every non-production label", () => {
    for (const nodeEnv of NODE_ENVS) {
      for (const appEnv of ["local", "dev", undefined] as Stub[]) {
        for (const devLogin of ["TRUE", "True", "1", "yes", " true"]) {
          stub(nodeEnv, appEnv, devLogin);
          expect(isDevLoginEnabled(), `NODE_ENV=${nodeEnv} APP_ENV=${appEnv} AUTH_DEV_LOGIN=${devLogin}`).toBe(false);
        }
      }
    }
  });

  it("test + AUTH_DEV_LOGIN=true → enabled", () => {
    stub("test", "local", "true");
    expect(isDevLoginEnabled()).toBe(true);
    stub("test", undefined, "true");
    expect(isDevLoginEnabled()).toBe(true);
  });

  it("the predicate never consults NODE_ENV: flipping it changes nothing while APP_ENV and AUTH_DEV_LOGIN are fixed", () => {
    for (const appEnv of ["production", "dev", "local", undefined] as Stub[]) {
      for (const devLogin of ["true", "false", undefined] as Stub[]) {
        const outcomes = new Set<boolean>();
        for (const nodeEnv of NODE_ENVS) {
          stub(nodeEnv, appEnv, devLogin);
          outcomes.add(isDevLoginEnabled());
        }
        expect(outcomes.size, `APP_ENV=${appEnv} AUTH_DEV_LOGIN=${devLogin}`).toBe(1);
      }
    }
  });
});

describe("dev personas", () => {
  it("exposes the four universe personas with the seed's ids and the contract groups", () => {
    expect(DEV_PERSONAS.map((p) => p.key)).toEqual(["ops", "cs", "advisor", "compliance"]);
    expect(DEV_PERSONAS.map((p) => p.id)).toEqual(["staff_marco", "staff_helen", "staff_rachel", "staff_priya"]);
    expect(findDevPersona("ops")?.groups).toEqual(["ops_team"]);
    expect(findDevPersona("compliance")?.groups).toEqual(["compliance_officers"]);
    for (const p of DEV_PERSONAS) expect(p.email.endsWith("@example.com")).toBe(true);
  });

  it("recognizes a persona account in any letter case, and nothing else", () => {
    expect(isPersonaUserId("staff_marco")).toBe(true);
    expect(isPersonaUserId(" STAFF_Priya ")).toBe(true);
    expect(isPersonaUserId("staff_sam")).toBe(false);
    expect(isPersonaUserId("")).toBe(false);
  });

  it("findDevPersona: known key → persona, unknown key → null", () => {
    expect(findDevPersona("ops")?.id).toBe("staff_marco");
    expect(findDevPersona("cs")?.name).toBe("Helen Carver");
    expect(findDevPersona("root")).toBeNull();
    expect(findDevPersona("")).toBeNull();
    expect(findDevPersona("OPS")).toBeNull();
  });

  it("provider id is the literal dev-persona", () => {
    expect(DEV_PROVIDER_ID).toBe("dev-persona");
  });
});
