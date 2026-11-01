/**
 * `src/lib/gcp-metadata.ts` — the single metadata-server client, and therefore the single place the
 * repository's `http://` literal lives (security scanner CWE-319; the scanner's config exempts this
 * one file).
 *
 * The tests that matter: the URL and the `Metadata-Flavor` header are exactly what the server
 * requires, a failure is a typed `GcpMetadataError` rather than a silent empty credential, and no
 * error path carries the response body — which on this endpoint is the token itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  GcpMetadataError,
  METADATA_DEFAULT_HOST,
  METADATA_TIMEOUT_MS,
  fetchAccessToken,
  fetchServiceAccountEmail,
  metadataHost,
  metadataUrl,
} from "@/lib/gcp-metadata";

type Call = { url: string; init: RequestInit | undefined };

/** A fetch stand-in that records its calls and answers with the given responses in order. */
function stubFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[i++];
    if (next === undefined) throw new Error("stubFetch: no response queued");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headerOf(call: Call, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe("metadataHost / metadataUrl", () => {
  it("defaults to the well-known internal name", () => {
    expect(metadataHost({})).toBe(METADATA_DEFAULT_HOST);
    expect(metadataUrl("instance/id", {})).toBe(`http://${METADATA_DEFAULT_HOST}/computeMetadata/v1/instance/id`);
  });

  it("honours GCE_METADATA_HOST, with or without a port", () => {
    expect(metadataHost({ GCE_METADATA_HOST: "127.0.0.1:8080" })).toBe("127.0.0.1:8080");
    expect(metadataUrl("instance/id", { GCE_METADATA_HOST: "127.0.0.1:8080" })).toBe(
      "http://127.0.0.1:8080/computeMetadata/v1/instance/id",
    );
  });

  it("ignores an empty or whitespace override rather than building http:///", () => {
    expect(metadataHost({ GCE_METADATA_HOST: "" })).toBe(METADATA_DEFAULT_HOST);
    expect(metadataHost({ GCE_METADATA_HOST: "   " })).toBe(METADATA_DEFAULT_HOST);
  });

  it("rejects an override that carries a scheme instead of concatenating a broken URL", () => {
    expect(() => metadataHost({ GCE_METADATA_HOST: "http://127.0.0.1" })).toThrow(GcpMetadataError);
    expect(() => metadataHost({ GCE_METADATA_HOST: "https://metadata.example" })).toThrow(/must be a host/);
  });

  it("accepts a path with or without a leading slash", () => {
    expect(metadataUrl("/instance/id", {})).toBe(metadataUrl("instance/id", {}));
  });
});

describe("fetchAccessToken", () => {
  it("calls the default-service-account token endpoint with the flavor header and a timeout", async () => {
    const { fetchImpl, calls } = stubFetch([json({ access_token: "ya29.token", expires_in: 3599 })]);
    const result = await fetchAccessToken(undefined, { fetchImpl, env: {} });

    expect(result).toEqual({ token: "ya29.token", expiresInSeconds: 3599 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `http://${METADATA_DEFAULT_HOST}/computeMetadata/v1/instance/service-accounts/default/token`,
    );
    expect(headerOf(calls[0], "Metadata-Flavor")).toBe("Google");
    expect(calls[0].init?.cache).toBe("no-store");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends requested scopes comma-separated and URL-encoded", async () => {
    const { fetchImpl, calls } = stubFetch([json({ access_token: "t", expires_in: 60 })]);
    await fetchAccessToken(["https://www.googleapis.com/auth/devstorage.read_only", "  ", "openid"], {
      fetchImpl,
      env: {},
    });
    expect(calls[0].url).toBe(
      `http://${METADATA_DEFAULT_HOST}/computeMetadata/v1/instance/service-accounts/default/token` +
        "?scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdevstorage.read_only,openid",
    );
  });

  it("omits the query entirely when no usable scope was asked for", async () => {
    const { fetchImpl, calls } = stubFetch([json({ access_token: "t", expires_in: 60 })]);
    await fetchAccessToken([" ", ""], { fetchImpl, env: {} });
    expect(calls[0].url.includes("?")).toBe(false);
  });

  it("reports expiresInSeconds as 0 when the server omits or corrupts expires_in", async () => {
    const { fetchImpl } = stubFetch([json({ access_token: "t" }), json({ access_token: "t", expires_in: -5 })]);
    expect((await fetchAccessToken(undefined, { fetchImpl, env: {} })).expiresInSeconds).toBe(0);
    expect((await fetchAccessToken(undefined, { fetchImpl, env: {} })).expiresInSeconds).toBe(0);
  });

  it("throws `unreachable` when the request fails or times out", async () => {
    const { fetchImpl } = stubFetch([new Error("getaddrinfo ENOTFOUND metadata.google.internal")]);
    await expect(fetchAccessToken(undefined, { fetchImpl, env: {} })).rejects.toMatchObject({
      name: "GcpMetadataError",
      reason: "unreachable",
    });
  });

  it("never repeats the underlying fetch failure's text", async () => {
    const { fetchImpl } = stubFetch([new Error("connect to 10.1.2.3 refused for account svc@proj.iam")]);
    const error = await fetchAccessToken(undefined, { fetchImpl, env: {} }).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toBe("gcp metadata server: no response (not running on GCP, or the request timed out)");
    expect(message.includes("svc@proj.iam")).toBe(false);
    expect(message.includes("10.1.2.3")).toBe(false);
  });

  it("throws `status` carrying the code but not the body", async () => {
    const { fetchImpl } = stubFetch([new Response("ya29.leaked-token", { status: 403 })]);
    const error = await fetchAccessToken(undefined, { fetchImpl, env: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GcpMetadataError);
    expect(error).toMatchObject({ reason: "status", status: 403 });
    expect((error as Error).message.includes("ya29")).toBe(false);
  });

  it("throws `malformed` for a non-JSON body or a missing access_token", async () => {
    const { fetchImpl } = stubFetch([
      new Response("not json", { status: 200 }),
      json({ expires_in: 60 }),
      json({ access_token: "" }),
    ]);
    const messages: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await fetchAccessToken(undefined, { fetchImpl, env: {} }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GcpMetadataError);
      expect((error as GcpMetadataError).reason).toBe("malformed");
      messages.push((error as Error).message);
    }
    expect(messages[0].includes("token response was not JSON")).toBe(true);
    expect(messages[1].includes("carried no access_token")).toBe(true);
    expect(messages[2].includes("carried no access_token")).toBe(true);
  });

  it("uses the configured timeout budget", () => {
    expect(METADATA_TIMEOUT_MS).toBeGreaterThan(0);
    expect(METADATA_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("fetchServiceAccountEmail", () => {
  it("returns the trimmed plain-text identity", async () => {
    const { fetchImpl, calls } = stubFetch([new Response("service-account@example-project.iam.gserviceaccount.com\n")]);
    await expect(fetchServiceAccountEmail({ fetchImpl, env: {} })).resolves.toBe(
      "service-account@example-project.iam.gserviceaccount.com",
    );
    expect(calls[0].url).toBe(
      `http://${METADATA_DEFAULT_HOST}/computeMetadata/v1/instance/service-accounts/default/email`,
    );
    expect(headerOf(calls[0], "Metadata-Flavor")).toBe("Google");
  });

  it("throws rather than returning an empty identity", async () => {
    const { fetchImpl } = stubFetch([new Response("  \n")]);
    await expect(fetchServiceAccountEmail({ fetchImpl, env: {} })).rejects.toMatchObject({ reason: "malformed" });
  });

  it("surfaces a non-200 as a status failure", async () => {
    const { fetchImpl } = stubFetch([new Response("nope", { status: 500 })]);
    await expect(fetchServiceAccountEmail({ fetchImpl, env: {} })).rejects.toMatchObject({
      reason: "status",
      status: 500,
    });
  });
});

describe("source-level guarantees", () => {
  const source = readFileSync(new URL("./gcp-metadata.ts", import.meta.url), "utf8");

  it("holds exactly one http:// literal, in metadataUrl — the one the scanner's config exempts", () => {
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code.split("http://").length - 1).toBe(1);
    expect(code.includes("return `http://${metadataHost(env)}/computeMetadata/v1/${suffix}`;")).toBe(true);
  });

  it("never writes a caught value to a console (CWE-209)", () => {
    expect(source.includes("console.")).toBe(false);
  });
});
