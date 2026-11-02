import { describe, expect, it } from "vitest";
import { safeAuthRedirect } from "@/lib/auth/redirect";

const BASE_URL = "https://ops-portal.example.com";

describe("safeAuthRedirect", () => {
  it("allows root-relative and exact same-origin destinations", () => {
    expect(
      safeAuthRedirect({ url: "/command-center?view=open#today", baseUrl: BASE_URL }),
    ).toBe("https://ops-portal.example.com/command-center?view=open#today");
    expect(
      safeAuthRedirect({ url: "https://ops-portal.example.com/client-portrait", baseUrl: BASE_URL }),
    ).toBe("https://ops-portal.example.com/client-portrait");
  });

  it("rejects a hostname that merely starts with the application URL", () => {
    expect(
      safeAuthRedirect({
        url: "https://ops-portal.example.com.attacker.tld/phishing",
        baseUrl: BASE_URL,
      }),
    ).toBe(BASE_URL);
  });

  it("rejects credential-host and protocol-relative redirects", () => {
    expect(
      safeAuthRedirect({
        url: "https://ops-portal.example.com@attacker.tld/phishing",
        baseUrl: BASE_URL,
      }),
    ).toBe(BASE_URL);
    expect(
      safeAuthRedirect({ url: "//attacker.tld/phishing", baseUrl: BASE_URL }),
    ).toBe(BASE_URL);
  });

  it("rejects non-HTTP and malformed destinations", () => {
    expect(safeAuthRedirect({ url: "javascript:alert(1)", baseUrl: BASE_URL })).toBe(BASE_URL);
    expect(safeAuthRedirect({ url: "https://%", baseUrl: BASE_URL })).toBe(BASE_URL);
  });

  it("normalizes default ports but rejects a genuinely different port", () => {
    expect(
      safeAuthRedirect({
        url: "https://ops-portal.example.com:443/households",
        baseUrl: BASE_URL,
      }),
    ).toBe("https://ops-portal.example.com/households");
    expect(
      safeAuthRedirect({
        url: "https://ops-portal.example.com:444/households",
        baseUrl: BASE_URL,
      }),
    ).toBe(BASE_URL);
  });
});
