/**
 * `@/test-support/db-url`, the module that exists so no credential-shaped literal is in the tree.
 *
 * Every assertion reads the URL back through `URL` rather than comparing it to a string. That is not
 * squeamishness: a test that spelled the expected connection string out would put the literal back
 * into a tracked file and reopen SECRET-3012 in the one place where it would be most embarrassing.
 * Parsed parts prove the same thing and carry no credential pair.
 */
import { describe, expect, it } from "vitest";
import { composeDatabaseUrl, unitDatabaseUrl } from "@/test-support/db-url";

describe("composeDatabaseUrl", () => {
  it("assembles the credentials, host, port, database and query", () => {
    const url = new URL(
      composeDatabaseUrl({
        user: "app",
        password: "s3cr3t",
        host: "db.internal",
        port: 6432,
        database: "wm",
        query: "schema=public",
      }),
    );
    expect(url.protocol).toBe("postgresql:");
    expect(url.username).toBe("app");
    expect(url.password).toBe("s3cr3t");
    expect(url.hostname).toBe("db.internal");
    expect(url.port).toBe("6432");
    expect(url.pathname).toBe("/wm");
    expect(url.search).toBe("?schema=public");
  });

  it("defaults to localhost:5432 and omits what the caller omits", () => {
    const url = new URL(composeDatabaseUrl());
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("5432");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.search).toBe("");
  });

  it("writes an authority with no port at all when port is null", () => {
    // `postgresql:` is a non-special scheme, which is exactly why `URL` is used here: it neither
    // injects a default port nor appends a `/` to an authority-only URL, so the string round-trips.
    expect(composeDatabaseUrl({ host: "/cloudsql/proj:region:inst", port: null })).not.toContain("5432");
    expect(new URL(composeDatabaseUrl({ host: "db.internal", port: null })).port).toBe("");
  });

  it("percent-encodes a password that would otherwise break the authority", () => {
    // libpq reads the authority by delimiter, so an unencoded `@` or `/` in a password silently
    // repoints the connection at another host. `URL` encodes it; string concatenation would not.
    const raw = "p@ss/w:rd?";
    const url = new URL(composeDatabaseUrl({ user: "app", password: raw, database: "wm" }));
    expect(url.password).not.toBe(raw);
    expect(decodeURIComponent(url.password)).toBe(raw);
    expect(url.hostname).toBe("localhost");
    expect(url.pathname).toBe("/wm");
  });
});

describe("unitDatabaseUrl", () => {
  it("points at a database name that exists nowhere, so an accidental connection fails loudly", () => {
    const url = new URL(unitDatabaseUrl());
    expect(url.pathname).toBe("/unit_never_connects");
    expect(url.hostname).toBe("localhost");
    expect(url.username).toBe("unit");
    expect(url.password).toBe("unit");
  });

  it("takes an override database name", () => {
    expect(new URL(unitDatabaseUrl("other_never_connects")).pathname).toBe("/other_never_connects");
  });
});
