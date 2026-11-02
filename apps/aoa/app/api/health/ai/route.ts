import { requireIngestToken } from "@/lib/ingest/auth";
import { aiDraftingEnabled } from "@/lib/flags";
import { AiError, generateText, geminiConfig } from "@/lib/ai/gemini";

// Readiness probe for the Gemini drafting engine (lib/ai/gemini.ts). Confirms —
// from INSIDE the running app, as the app's own identity — that a Gemini model
// actually answers. Intentionally INDEPENDENT of the AI_DRAFTING feature flag so
// it can verify readiness BEFORE the feature is turned on; auth is the ingest
// bearer token (requireIngestToken → INGEST_TOKEN), and /api/health/* is already
// middleware-excluded from the Okta session gate. Both GET and POST allowed (an
// uptime/scheduler monitor may use either); every other verb is 405.
//
// It makes ONE tiny billable generateContent call. NO-LOG: the response body
// carries only status + model + latency — never the model's text, the prompt, or
// any config secret.
export const runtime = "nodejs";

const err = (error: string, status: number) => Response.json({ error }, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

async function probe(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  const cfg = geminiConfig();
  const startedAt = Date.now();
  try {
    const res = await generateText({
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 256,
    });
    return Response.json({
      ok: true,
      model: res.model, // the model that answered (may be the fallback)
      configuredModel: cfg.model,
      location: cfg.location,
      finishReason: res.finishReason,
      latencyMs: Date.now() - startedAt,
      aiDraftingEnabled: aiDraftingEnabled(),
    });
  } catch (e) {
    const reason = e instanceof AiError ? e.reason : "error";
    // 503 for a genuine unavailability so a monitor treats it as down; the
    // reason is a static enum (never the model output or a secret).
    return Response.json(
      { ok: false, reason, configuredModel: cfg.model, location: cfg.location },
      { status: 503 },
    );
  }
}

export const GET = probe;
export const POST = probe;
