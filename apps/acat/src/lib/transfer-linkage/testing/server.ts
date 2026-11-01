/** Isolated synthetic producer only. Never imported by production routes. */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { OAuth2Client } from "google-auth-library";
import { extractBearerToken, getExpectedAudience, verifyTransferLinkageCaller } from "../../machine-auth";
import { SYNTHETIC_EPOCHS, syntheticSnapshot, type SyntheticEpoch } from "./fixtures";

const headers = { "Cache-Control": "private, no-store, max-age=0", "Content-Type": "application/json", Vary: "Authorization" };
const response = (body: unknown, status = 200) => Response.json(body, { status, headers });
const controlClient = new OAuth2Client();

async function verifyControl(request: Request): Promise<boolean> {
  const allowed = new Set((process.env.ACAT_SYNTHETIC_CONTROL_ALLOWED_SAS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token || !allowed.size) return false;
  try {
    const payload = (await controlClient.verifyIdToken({ idToken: token, audience: getExpectedAudience() })).getPayload();
    const email = payload?.email?.trim().toLowerCase();
    return payload?.email_verified === true && !!email && email !== "ops-portal-run@ops-portal.iam.gserviceaccount.com" && allowed.has(email);
  } catch { return false; }
}

export function createSyntheticHandler() {
  let epoch: SyntheticEpoch = "baseline";
  return async (request: Request): Promise<Response> => {
    if (process.env.TRANSFER_LINKAGE_ENVIRONMENT !== "synthetic" || process.env.TRANSFER_LINKAGE_ENABLED !== "true" ||
      !process.env.MACHINE_AUTH_AUDIENCE?.trim() || getExpectedAudience() === "https://transfer-tracker.invalid") {
      return response({ error: "synthetic_not_configured" }, 503);
    }
    const url = new URL(request.url);
    if (url.search) return response({ error: "invalid_request" }, 400);
    if (url.pathname === "/__synthetic/epoch") {
      // Separate explicit identity grant; ordinary consumer credentials cannot
      // change test epochs. No control route exists in the production Next app.
      if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
      if (!await verifyControl(request)) return response({ error: "unauthorized" }, 401);
      const body = await request.text();
      if (body.length > 256) return response({ error: "invalid_request" }, 400);
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return response({ error: "invalid_request" }, 400); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 || !("epoch" in parsed) || !SYNTHETIC_EPOCHS.includes(parsed.epoch as SyntheticEpoch)) return response({ error: "invalid_request" }, 400);
      epoch = parsed.epoch as SyntheticEpoch;
      return response({ epoch });
    }
    const pointMatch = /^\/api\/machine\/transfer-linkage\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
    const scope = url.pathname === "/api/machine/transfer-linkage" ? "snapshot" : pointMatch ? "record" : null;
    if (!scope) return response({ error: "not_found" }, 404);
    if (!await verifyTransferLinkageCaller(request, scope)) return response({ error: "unauthorized" }, 401);
    const snapshot = syntheticSnapshot(epoch);
    if (scope === "snapshot") return response(snapshot);
    const record = snapshot.records.find((row) => row.recordId === pointMatch![1]) ?? null;
    return response({ contractVersion: snapshot.contractVersion, source: snapshot.source, scope: "RECORD", complete: false,
      observedAt: snapshot.observedAt, directory: snapshot.directory,
      outcome: record ? record.deletedAt ? "DELETED" : "FOUND" : "MISSING", record });
  };
}

export function startSyntheticServer(port = Number(process.env.PORT ?? 8080), host = "127.0.0.1") {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A valid synthetic server port is required");
  const handler = createSyntheticHandler();
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 256) { outgoing.writeHead(413, headers).end('{"error":"body_too_large"}'); return; }
        chunks.push(Buffer.from(chunk));
      }
      const method = incoming.method ?? "GET";
      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        for (const item of value === undefined ? [] : Array.isArray(value) ? value : [value]) requestHeaders.append(key, item);
      }
      const request = new Request(`http://synthetic.local${incoming.url ?? "/"}`, { method,
        headers: requestHeaders,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
      const result = await handler(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(await result.text());
    } catch { outgoing.writeHead(503, headers).end('{"error":"synthetic_unavailable"}'); }
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Cloud Run private service uses PORT; localhost remains the default for tests.
  startSyntheticServer(Number(process.env.PORT ?? 8080), process.env.ACAT_SYNTHETIC_BIND_HOST ?? "127.0.0.1");
}
