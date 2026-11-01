/**
 * Gemini on Vertex AI over plain REST — node, layer L2.
 *
 * **No SDK, by contract and by preference.** `@google-cloud/vertexai` would be a new dependency
 * (forbidden this wave) pulling a transitive auth stack into a books-and-records service to do what
 * `fetch` plus one metadata call already does. The surface used here is one endpoint and one JSON
 * shape.
 *
 * **No API key, ever.** Authentication is the runtime service account: on Cloud Run the metadata
 * server mints an access token for the default identity, and the identity is granted
 * `roles/aiplatform.user`. Locally there is no metadata server, so `GOOGLE_OAUTH_ACCESS_TOKEN` —
 * what `gcloud auth print-access-token` prints — is accepted instead. A long-lived key in an
 * environment variable would be a stored credential in every backup and every Reg S-P inventory, for
 * a feature that writes drafts.
 *
 * `GOOGLE_OAUTH_ACCESS_TOKEN` is read from `process.env` rather than from `@/lib/env`: that module is
 * foundation-owned and the key is not in its schema. The precedent is
 * `src/lib/okta-groups.ts` and `src/lib/integration-scope.ts`, which read their keys the same way and
 * say so. It is deliberately a DEVELOPER convenience, so it is checked first and, when present, the
 * metadata server is never called — a workstation has no metadata server and the DNS failure there is
 * slow. Recorded in the build record.
 *
 * **Nothing is cached across requests except the access token**, and that for slightly less than its
 * own lifetime. No response, no prompt and no draft is retained by this module.
 */
import type { AiDraftProvider } from "@/lib/ai/provider";
import { AiProviderError } from "@/lib/ai/errors";
import { buildDraftPrompt } from "@/lib/ai/prompt";
import { GcpMetadataError, fetchAccessToken } from "@/lib/gcp-metadata";

/** Re-fetch a minute before expiry so a long generation never runs off the end of the token. */
const TOKEN_SKEW_MS = 60_000;

/** A draft is a few hundred words. A model that has not answered in 45 s is not about to. */
export const VERTEX_TIMEOUT_MS = 45_000;

/** Upper bound on the generated draft. Longer than any reply a desk should send. */
export const VERTEX_MAX_OUTPUT_TOKENS = 1_024;

/** Low, not zero: a reply that reads like a person, without inventing facts. */
export const VERTEX_TEMPERATURE = 0.2;

export type VertexConfig = { project: string; location: string; model: string };

type CachedToken = { token: string; expiresAtMs: number };
let tokenCache: CachedToken | null = null;

/** Test seam: drops the cached access token. */
export function resetVertexTokenCacheForTests(): void {
  tokenCache = null;
}

/**
 * Wraps a `GcpMetadataError` in the `AiProviderError` the rest of this module throws, keeping the
 * message shapes the provider's callers already match on. The metadata module's message never carries
 * the response body — on that endpoint the body IS the credential — so nothing sensitive is copied
 * here. The same wrapper `src/lib/storage.ts` has, for the same reason.
 */
function asProviderError(e: unknown): AiProviderError {
  if (!(e instanceof GcpMetadataError)) return new AiProviderError("vertex", "metadata server call failed");
  if (e.status !== null) return new AiProviderError("vertex", `metadata server responded ${e.status}`);
  const detail = e.reason === "unreachable" ? "was unreachable" : "returned no access token";
  return new AiProviderError("vertex", `metadata server ${detail}`);
}

/**
 * An OAuth access token for the runtime identity.
 *
 * `GOOGLE_OAUTH_ACCESS_TOKEN` wins when set (local development). Otherwise the metadata server. Both
 * paths fail loudly: a provider that silently produced an unauthenticated request would surface as a
 * 401 the operator cannot act on.
 */
async function accessToken(): Promise<string> {
  const local = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (local) return local;

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + TOKEN_SKEW_MS) return tokenCache.token;

  // The metadata protocol lives in `@/lib/gcp-metadata` — the ONE file in the tree that holds an
  // `http://` literal and the one file the scanner's config exempts from CWE-319. That
  // module is stateless on purpose, so the cache and the 60s skew above stay here, next to the reset
  // hook the tests already use. `src/lib/storage.ts` keeps its own cache for the same reason.
  let fetched;
  try {
    fetched = await fetchAccessToken();
  } catch (e) {
    throw asProviderError(e);
  }
  const ttl = fetched.expiresInSeconds > 0 ? fetched.expiresInSeconds : 600;
  tokenCache = { token: fetched.token, expiresAtMs: now + ttl * 1000 };
  return tokenCache.token;
}

export function generateContentUrl(cfg: VertexConfig): string {
  const { project, location, model } = cfg;
  return (
    `https://${encodeURIComponent(location)}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}` +
    `/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`
  );
}

/** The `generateContent` request body. Shaped here so a unit test can assert on it without a network. */
export function generateContentBody(prompt: { system: string; user: string }): unknown {
  return {
    systemInstruction: { role: "system", parts: [{ text: prompt.system }] },
    contents: [{ role: "user", parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: VERTEX_TEMPERATURE,
      maxOutputTokens: VERTEX_MAX_OUTPUT_TOKENS,
      // The model must not return anything but prose: the composer inserts this straight into a
      // textarea an operator reads as the reply.
      responseMimeType: "text/plain",
    },
  };
}

type GenerateContentResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }>;
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  modelVersion?: unknown;
};

/** Concatenates the first candidate's text parts. Anything else is an upstream shape we do not accept. */
export function extractDraftText(raw: unknown): string {
  const body = raw as GenerateContentResponse;
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  if (text === "") {
    // A blocked or empty candidate. The finish reason is a short enum, safe to surface; the response
    // body is not, so it never reaches the message.
    const reason = typeof body.candidates?.[0]?.finishReason === "string" ? body.candidates[0].finishReason : "empty";
    throw new AiProviderError("vertex", `the model returned no text (${reason})`);
  }
  return text;
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * A provider bound to one project/location/model.
 *
 * Every call builds its own prompt from the arguments it is given; the provider holds no ticket
 * state, so two concurrent drafts on two tickets cannot see each other.
 */
export function createVertexProvider(cfg: VertexConfig): AiDraftProvider {
  const url = generateContentUrl(cfg);

  return {
    name: "vertex",
    async draft(input) {
      const prompt = buildDraftPrompt({
        ticket: input.ticket,
        thread: input.thread,
        instruction: input.instruction ?? null,
        macroBody: input.macroBody ?? null,
      });
      const token = await accessToken();

      // `AbortSignal.timeout` rather than a manual controller + timer: no handle to leak and no
      // interval keeping an idle instance warm (the same reasoning the denial throttle uses).
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(generateContentBody(prompt)),
          cache: "no-store",
          signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
        });
      } catch (e) {
        // A network error's message can carry the URL and, on some runtimes, request detail. Only the
        // error's NAME crosses this boundary.
        const name = e instanceof Error ? e.name : typeof e;
        throw new AiProviderError("vertex", `the request to Vertex AI failed (${name})`);
      }

      if (!res.ok) throw new AiProviderError("vertex", `Vertex AI responded ${res.status}`);

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AiProviderError("vertex", "Vertex AI returned a response that was not JSON");
      }

      const parsed = body as GenerateContentResponse;
      return {
        text: extractDraftText(body),
        // The concrete version that answered, when Vertex reports one; otherwise the configured
        // alias. The audit row records what actually wrote the draft.
        model: typeof parsed.modelVersion === "string" && parsed.modelVersion !== "" ? parsed.modelVersion : cfg.model,
        promptTokens: tokenCount(parsed.usageMetadata?.promptTokenCount),
        outputTokens: tokenCount(parsed.usageMetadata?.candidatesTokenCount),
      };
    },
  };
}
