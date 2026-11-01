import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashSecret, verifyPkceS256, base64Url } from "./crypto";
import { createHash } from "crypto";

describe("MCP crypto helpers", () => {
  it("hashes secrets deterministically without storing raw values", () => {
    const first = hashSecret("secret-value");
    const second = hashSecret("secret-value");
    expect(first).toBe(second);
    expect(first).not.toContain("secret-value");
  });

  it("creates opaque tokens with display metadata", () => {
    const token = createOpaqueToken("acat_test");
    expect(token.token).toMatch(/^acat_test_/);
    expect(token.hash).toBe(hashSecret(token.token));
    expect(token.publicPrefix).toContain("acat_test");
    expect(token.lastFour).toHaveLength(4);
  });

  it("verifies PKCE S256 challenges", () => {
    const verifier = "pkce-verifier";
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256("wrong", challenge)).toBe(false);
  });
});
