// The demo database's logins (lib/demo/logins): passwords derived from the owner's, the four runtime URLs, the owner URL
// the deploy and reset use, and the reset gate's token.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEMO_LOGIN_ROLES, demoLoginPassword, demoLoginUrls, demoOwnerDirectUrl, demoResetGateToken, ensureDemoLogins,
} from "@/lib/demo/logins";

const OWNER_PW = "npg_SyntheticOwner1234";
const NEON_OWNER = `postgresql://aoa:${OWNER_PW}@ep-example-123-pooler.c-6.us-east-2.aws.neon.tech/aoa?sslmode=require&connect_timeout=20`;

describe("demoLoginPassword", () => {
  it("is the same every time for one owner password and login, so a redeploy changes nothing", () => {
    expect(demoLoginPassword(OWNER_PW, "app_rw")).toBe(demoLoginPassword(OWNER_PW, "app_rw"));
  });

  it("differs per login and per owner password, and never is the owner password", () => {
    const passwords = DEMO_LOGIN_ROLES.map((role) => demoLoginPassword(OWNER_PW, role));
    expect(new Set(passwords).size).toBe(DEMO_LOGIN_ROLES.length);
    expect(passwords).not.toContain(OWNER_PW);
    expect(demoLoginPassword(`${OWNER_PW}x`, "app_rw")).not.toBe(passwords[0]);
  });

  it("is 43 base64url characters with no character three times in a row (Neon refuses those)", () => {
    for (let i = 0; i < 2000; i++) {
      for (const role of DEMO_LOGIN_ROLES) {
        const password = demoLoginPassword(`owner-password-${i}`, role);
        expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(password).not.toMatch(/(.)\1\1/);
      }
    }
  });

  it("refuses a short owner password", () => {
    expect(() => demoLoginPassword("short", "app_rw")).toThrow("demo_owner_password_too_short");
  });
});

describe("demoLoginUrls", () => {
  it("gives the web service production's four settings on Neon's direct host, each with its login and schema", () => {
    const urls = demoLoginUrls(NEON_OWNER);
    const parsed = Object.fromEntries(Object.entries(urls).map(([key, url]) => [key, new URL(url)]));
    expect(Object.keys(urls).sort()).toEqual(
      ["CRM_RECONCILER_DATABASE_URL", "DATABASE_URL", "DIRECT_DATABASE_URL", "INGEST_DATABASE_URL"],
    );
    expect(parsed.DATABASE_URL.username).toBe("app_rw");
    expect(parsed.DIRECT_DATABASE_URL.username).toBe("app_rw");
    expect(parsed.INGEST_DATABASE_URL.username).toBe("ingest_rw");
    expect(parsed.CRM_RECONCILER_DATABASE_URL.username).toBe("identity_reconciler");
    expect(parsed.DATABASE_URL.searchParams.get("schema")).toBe("app");
    expect(parsed.INGEST_DATABASE_URL.searchParams.get("schema")).toBe("mirror");
    for (const url of Object.values(parsed)) {
      expect(url.hostname).toBe("ep-example-123.c-6.us-east-2.aws.neon.tech");
      expect(url.pathname).toBe("/aoa");
      expect(url.searchParams.get("sslmode")).toBe("require");
      expect(url.searchParams.get("connect_timeout")).toBe("20");
      expect(url.password).toBe(demoLoginPassword(OWNER_PW, url.username as "app_rw"));
    }
    expect(Object.values(urls).join(" ")).not.toContain(OWNER_PW);
  });

  it("leaves the passwords out for a local owner without one", () => {
    const urls = demoLoginUrls("postgresql://aoa@127.0.0.1:5544/aoa_test?schema=app");
    expect(urls.INGEST_DATABASE_URL).toBe("postgresql://ingest_rw@127.0.0.1:5544/aoa_test?schema=mirror");
    expect(urls.DATABASE_URL).toBe("postgresql://app_rw@127.0.0.1:5544/aoa_test?schema=app");
  });

  it("refuses any login but the owner, and anything but a Postgres URL", () => {
    expect(() => demoLoginUrls("postgresql://app_rw:secret-secret-secret@127.0.0.1/aoa")).toThrow("demo_owner_login_required");
    expect(() => demoLoginUrls("https://aoa:secret-secret-secret@example.com/aoa")).toThrow("demo_owner_url_not_postgres");
  });
});

describe("ensureDemoLogins", () => {
  it("lets the owner act as the app login and sets each runtime login's derived password", async () => {
    const statements: string[] = [];
    const owner = { $executeRawUnsafe: vi.fn(async (sql: string) => void statements.push(sql)) };
    await ensureDemoLogins(owner as never, NEON_OWNER);
    expect(statements[0]).toBe("GRANT app_rw TO aoa WITH INHERIT FALSE, SET TRUE");
    expect(statements.slice(1)).toEqual(
      DEMO_LOGIN_ROLES.map((role) => `ALTER ROLE ${role} WITH LOGIN PASSWORD '${demoLoginPassword(OWNER_PW, role)}'`),
    );
  });

  it("only grants the role switch when the owner has no password", async () => {
    const owner = { $executeRawUnsafe: vi.fn(async () => 0) };
    await ensureDemoLogins(owner as never, "postgresql://aoa@127.0.0.1:5544/aoa_test");
    expect(owner.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe("demoOwnerDirectUrl", () => {
  it("turns Neon's pooled owner string into the direct one with the app schema, as the deploy and reset need", () => {
    const url = new URL(demoOwnerDirectUrl(`postgresql://aoa:${OWNER_PW}@ep-example-123-pooler.c-6.us-east-2.aws.neon.tech/aoa?sslmode=require&channel_binding=require`));
    expect(url.hostname).toBe("ep-example-123.c-6.us-east-2.aws.neon.tech");
    expect(url.username).toBe("aoa");
    expect(url.password).toBe(OWNER_PW);
    expect(url.searchParams.get("schema")).toBe("app");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("connect_timeout")).toBe("20");
    expect(url.searchParams.has("channel_binding")).toBe(false);
  });

  it("keeps a connect timeout already given, and refuses any login but the owner", () => {
    expect(new URL(demoOwnerDirectUrl(NEON_OWNER)).searchParams.get("connect_timeout")).toBe("20");
    expect(() => demoOwnerDirectUrl("postgresql://app_rw:secret-secret-secret@host/aoa")).toThrow("demo_owner_login_required");
  });
});

describe("demoResetGateToken", () => {
  it("is the same for the deploy and the reset, differs from every login password, and needs the owner password", () => {
    const token = demoResetGateToken(NEON_OWNER);
    expect(token).toBe(demoResetGateToken(demoOwnerDirectUrl(NEON_OWNER)));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const role of DEMO_LOGIN_ROLES) expect(token).not.toBe(demoLoginPassword(OWNER_PW, role));
    expect(() => demoResetGateToken("postgresql://aoa@127.0.0.1:5544/aoa_test")).toThrow("demo_owner_password_too_short");
  });
});
