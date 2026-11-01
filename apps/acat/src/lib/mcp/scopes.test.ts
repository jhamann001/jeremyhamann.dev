import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_SCOPES, hasScopes, parseScopes, scopeString } from "./scopes";

describe("MCP scopes", () => {
  it("defaults to read-only Claude scopes", () => {
    expect(parseScopes(undefined)).toEqual(DEFAULT_MCP_SCOPES);
  });

  it("deduplicates supported scopes", () => {
    expect(parseScopes("acats:read acats:read fees:read")).toEqual([
      "acats:read",
      "fees:read",
    ]);
    expect(scopeString(["fees:read", "fees:read"])).toBe("fees:read");
  });

  it("rejects unsupported scopes", () => {
    expect(() => parseScopes("acats:write")).toThrow("Unsupported MCP scope");
  });

  it("checks required scopes", () => {
    expect(hasScopes(["acats:read", "fees:read"], ["acats:read"])).toBe(true);
    expect(hasScopes(["fees:read"], ["acats:read"])).toBe(false);
  });
});
