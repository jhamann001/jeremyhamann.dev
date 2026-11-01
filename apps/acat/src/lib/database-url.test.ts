// @vitest-environment node

import { describe, expect, it } from "vitest";
import { withConnectTimeout } from "./database-url";

describe("withConnectTimeout", () => {
  it("gives a connection string Neon's recommended 15 s connect timeout", () => {
    const url = new URL(withConnectTimeout("postgresql://app:pw@ep-demo-pooler.example.test/neondb?sslmode=require")!);
    expect(url.searchParams.get("connect_timeout")).toBe("15");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.hostname).toBe("ep-demo-pooler.example.test");
  });

  it("keeps a timeout the string already sets", () => {
    expect(withConnectTimeout("postgresql://app:pw@db.example.test/app?connect_timeout=30")).toContain("connect_timeout=30");
  });

  it("leaves an absent or unparseable value alone", () => {
    expect(withConnectTimeout(undefined)).toBeUndefined();
    expect(withConnectTimeout("not a url")).toBe("not a url");
  });
});
