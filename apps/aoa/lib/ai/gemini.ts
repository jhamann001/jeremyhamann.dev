import "server-only";
import { ServiceAuth } from "@/lib/demo/service-auth";
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

// Keyless Vertex AI (Gemini) text client — the low-level engine the AI-drafting
// seam (lib/ai/draft.ts) and the /api/health/ai probe call. Mirrors the keyless
// posture of lib/data/acat-status.ts: GoogleAuth mints an access token from the
// ambient identity (aoa-run@ on Cloud Run, `gcloud auth application-default`
// locally) — NO API key, nothing in Secret Manager. Grant is roles/aiplatform.user
// on aoa-run@ (see the reference: Gemini on GCP for AOA).
//
// ENDPOINT NUANCE (the discovery that cost us a false 404): the Gemini 3.x models
// answer on the GLOBAL Vertex endpoint (host `aiplatform.googleapis.com`,
// location `global`), NOT the regional `us-central1-aiplatform.googleapis.com`.
// Older model families may answer regionally. The default 3.8/3.5 pair is served
// globally, so the newest primary and its stable fallback work at one endpoint;
// every value remains env-overridable.
//
// THINKING-BUDGET TRAP: 3.x spends output tokens on reasoning before emitting
// text — a stingy maxOutputTokens returns an empty finishReason=MAX_TOKENS
// response. Default is generous (2048); callers drafting long copy raise it.
//
// NO-LOG discipline (mirrors acat-status.ts): NEVER log the token, the URL, the
// prompt, or the response — the prompt/response carry client PII. Only STATIC
// markers + status code + model id + latency.

const LOG_TAG = "ai:gemini";
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 30_000;

/** Thrown for any Gemini call failure; the caller maps it to a counts-free 5xx. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "config_error" // no project resolvable
      | "unauthorized" // 401/403 — IAM / token
      | "model_not_found" // 404 — model id not served at this location
      | "rate_limited" // 429
      | "upstream_error" // other non-2xx
      | "transport_error" // network / timeout
      | "empty_response", // 200 but no usable text (e.g. all-thinking MAX_TOKENS)
  ) {
    super(message);
    this.name = "AiError";
  }
}

export type GeminiConfig = {
  project: string;
  location: string;
  model: string;
  fallbackModel: string;
};

/** Resolve config from env (all overridable). project falls back to the ambient
 *  GCP project vars Cloud Run sets; empty → config_error at call time. */
export function geminiConfig(): GeminiConfig {
  return {
    project:
      process.env.VERTEX_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      "",
    location: process.env.VERTEX_LOCATION || "global",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash",
  };
}

/** Vertex host for a location — global has no region prefix. */
function hostFor(location: string): string {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

export type GenerateArgs = {
  prompt: string;
  /** Optional system instruction (persona / guardrails). */
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
};

export type GenerateResult = {
  text: string;
  /** The model that actually answered (may be the fallback). */
  model: string;
  finishReason: string | null;
};

// One GoogleAuth per module — the client caches/refreshes tokens internally.
// cloud-platform scope is what generateContent (aiplatform) requires.
const auth = new ServiceAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

type RawResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
};

/** Extract the concatenated text of the first candidate (or "" if none). */
function extractText(body: RawResponse): { text: string; finishReason: string | null } {
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
  return { text, finishReason: cand?.finishReason ?? null };
}

/** Call ONE model. Throws AiError on any non-2xx / empty result. */
async function callModel(
  cfg: GeminiConfig,
  model: string,
  token: string,
  args: GenerateArgs,
): Promise<GenerateResult> {
  const url = `https://${hostFor(cfg.location)}/v1/projects/${cfg.project}/locations/${cfg.location}/publishers/google/models/${model}:generateContent`;
  const requestBody = {
    ...(args.system
      ? { systemInstruction: { parts: [{ text: args.system }] } }
      : {}),
    contents: [{ role: "user", parts: [{ text: args.prompt }] }],
    generationConfig: {
      maxOutputTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(args.temperature != null ? { temperature: args.temperature } : {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await serviceFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Sets the billing/quota project — required when authenticating with
        // user ADC locally; harmless (and correct) with the SA on Cloud Run.
        "x-goog-user-project": cfg.project,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch {
    console.error(`[${LOG_TAG}] transport_failed model=${model}`);
    throw new AiError("gemini request failed", "transport_error");
  } finally {
    clearTimeout(timer);
  }

  if (res.status !== 200) {
    // STATUS ONLY — never the body (may echo the prompt / client data).
    console.error(`[${LOG_TAG}] status=${res.status} model=${model}`);
    if (res.status === 404) throw new AiError("model not served", "model_not_found");
    if (res.status === 401 || res.status === 403)
      throw new AiError("gemini unauthorized", "unauthorized");
    if (res.status === 429) throw new AiError("gemini rate limited", "rate_limited");
    throw new AiError(`gemini ${res.status}`, "upstream_error");
  }

  const body = (await res.json().catch(() => ({}))) as RawResponse;
  const { text, finishReason } = extractText(body);
  if (text.trim() === "") {
    // 200 but nothing usable — commonly a thinking-only MAX_TOKENS truncation.
    console.error(`[${LOG_TAG}] empty_response model=${model} finish=${finishReason}`);
    throw new AiError("gemini returned no text", "empty_response");
  }
  return { text, model, finishReason };
}

/**
 * Generate text with Gemini. Tries the configured model; on a 404
 * (model_not_found — e.g. the newest id not yet served in this project/location)
 * falls back to the configured fallback model ONCE. Any other failure throws.
 * Read-only from the app's view; never logs prompt/response.
 */
export async function generateText(args: GenerateArgs): Promise<GenerateResult> {
  const cfg = geminiConfig();
  if (!cfg.project) {
    console.error(`[${LOG_TAG}] config_error project_unset`);
    throw new AiError("no GCP project configured for Vertex", "config_error");
  }

  const token = await auth.getAccessToken().catch(() => null);
  if (!token) throw new AiError("could not mint access token", "unauthorized");

  try {
    return await callModel(cfg, cfg.model, token, args);
  } catch (e) {
    if (
      e instanceof AiError &&
      e.reason === "model_not_found" &&
      cfg.fallbackModel &&
      cfg.fallbackModel !== cfg.model
    ) {
      console.error(`[${LOG_TAG}] falling_back to=${cfg.fallbackModel}`);
      return callModel(cfg, cfg.fallbackModel, token, args);
    }
    throw e;
  }
}
