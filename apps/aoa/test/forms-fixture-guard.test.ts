import { describe, expect, it } from "vitest";
import { formsBrowserEnvironment, validateFormsDatabaseEnvironment } from "./e2e/forms-fixture";

const environment = () => ({
  APP_ENV: "local",
  DATABASE_URL: "postgresql://app_rw:synthetic@127.0.0.1:55439/aoa_forms_synthetic?schema=app",
  DIRECT_DATABASE_URL: "postgresql://aoa:synthetic@127.0.0.1:55439/aoa_forms_synthetic?schema=app",
  INGEST_DATABASE_URL: "postgresql://ingest_rw:synthetic@127.0.0.1:55439/aoa_forms_synthetic?schema=mirror",
});

describe("forms browser isolation guards", () => {
  it("accepts only the explicit isolated local database and roles", () => {
    expect(validateFormsDatabaseEnvironment(environment()).runtimeUrl.port).toBe("55439");
  });
  it.each([
    ["DATABASE_URL", "postgresql://app_rw:synthetic@db.example.test:55439/aoa_forms_synthetic"],
    ["DATABASE_URL", "postgresql://app_rw:synthetic@127.0.0.1:5432/aoa_forms_synthetic"],
    ["DATABASE_URL", "postgresql://app_rw:synthetic@127.0.0.1:55439/aoa"],
    ["DATABASE_URL", "postgresql://aoa:synthetic@127.0.0.1:55439/aoa_forms_synthetic"],
    ["INGEST_DATABASE_URL", ""], ["APP_ENV", "dev"], ["APP_ENV", "prod"], ["K_SERVICE", "cloud-service"],
    ["GOOGLE_CLOUD_PROJECT", "cloud-project"],
  ])("refuses unsafe %s values before constructing a database client", (key, value) => {
    expect(() => validateFormsDatabaseEnvironment({ ...environment(), [key]: value })).toThrow();
  });
  it.each(["host", "hostaddr", "service", "servicefile", "options", "sslcert", "sslkey", "socket"])('refuses redirect/credential query parameter %s', (key) => {
    const env = environment();
    env.DATABASE_URL += `&${key}=external`;
    expect(() => validateFormsDatabaseEnvironment(env)).toThrow();
  });
  it("does not pass workstation secrets, node injection or source connector settings into the server", () => {
    const clean = formsBrowserEnvironment({ ...environment(), PATH: "/test/bin", HOME: "/test/home", AUTH_OKTA_SECRET: "do-not-copy", SLACK_BOT_TOKEN: "do-not-copy", NODE_OPTIONS: "--require external", WAREHOUSE_API_KEY: "do-not-copy", GOOGLE_APPLICATION_CREDENTIALS: "/test/actual-key.json" });
    expect(clean.PATH).toBe("/test/bin");
    expect(clean.AUTH_OKTA_SECRET).toBeUndefined();
    expect(clean.SLACK_BOT_TOKEN).toBeUndefined();
    expect(clean.NODE_OPTIONS).toBeUndefined();
    expect(clean.WAREHOUSE_API_KEY).toBe("");
    expect(clean.GOOGLE_APPLICATION_CREDENTIALS).toBe("/dev/null");
    expect(clean.GCE_METADATA_HOST).toBe("127.0.0.1:9");
    expect(clean.STATEMENT_PIPELINE_URL).toBe("");
  });
});
