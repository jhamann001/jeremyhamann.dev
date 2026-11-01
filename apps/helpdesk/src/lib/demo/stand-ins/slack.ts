/**
 * Slack, for the demo. The app's Slack client (src/jobs/slack.ts) posts to the incoming-webhook addresses
 * in SLA_ALERT_SLACK_WEBHOOK_URL and SLACK_QUEUE_WEBHOOKS. In demo mode those addresses point here, on a
 * loopback-only port inside the container, and each post lands in the Outbox. As at Slack, the path is the
 * webhook's credential: a post to any path the app was not configured with is refused.
 *
 * Addresses take the form http://127.0.0.1:<port>/slack/<channel>/<secret>; the channel segment is what
 * the Outbox shows as the destination.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { standInsPort } from "@/lib/demo/mode";
import type { OutboxEntry } from "@/lib/demo/outbox";

export type SlackStandInDeps = {
  record(entry: OutboxEntry): Promise<void>;
  now(): Date;
  /** The webhook addresses the app was configured with; read per request so a test can set them. */
  configuredUrls(): string[];
};

const MAX_BODY = 64 * 1024;

/** Every Slack address in the app's configuration: the SLA alert hook and each queue's hook. */
export function configuredSlackUrls(source: NodeJS.ProcessEnv = process.env): string[] {
  const urls: string[] = [];
  if (source.SLA_ALERT_SLACK_WEBHOOK_URL) urls.push(source.SLA_ALERT_SLACK_WEBHOOK_URL.trim());
  try {
    const map: unknown = JSON.parse(source.SLACK_QUEUE_WEBHOOKS ?? "{}");
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const value of Object.values(map)) if (typeof value === "string") urls.push(value.trim());
    }
  } catch {
    // env.ts refuses a malformed map at boot; nothing to add here.
  }
  return urls;
}

function samePath(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function slackStandInHandler(deps: SlackStandInDeps): RequestListener {
  return (req, res) => {
    const handle = async () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const configured = deps.configuredUrls().flatMap((raw) => {
        try {
          return [new URL(raw).pathname];
        } catch {
          return [];
        }
      });
      // Every configured path is compared, so the time taken does not say which one was close.
      const known = configured.map((p) => samePath(path, p)).some(Boolean);
      if (req.method !== "POST" || !path.startsWith("/slack/") || !known) return send(res, 404, "no_service");
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, "payload_too_large");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, "invalid_payload");
      }
      const text = (body as { text?: unknown }).text;
      if (typeof text !== "string" || text.trim() === "") return send(res, 400, "no_text");
      const channel = `#${decodeURIComponent(path.split("/")[2] ?? "desk")}`;
      await deps.record({
        transport: "slack",
        destination: channel,
        title: text.split("\n")[0]!.slice(0, 200),
        payload: { text },
        at: deps.now(),
      });
      send(res, 200, "ok");
    };
    handle().catch((error: unknown) => {
      // Never the path: it is the webhook's credential.
      console.error("[stand-ins] slack post failed", { error: error instanceof Error ? error.name : "UnknownError" });
      send(res, 500, "stand_in_error");
    });
  };
}

/** Start the Slack stand-in on 127.0.0.1. Resolves once it is listening. */
export function startSlackStandIn(deps: SlackStandInDeps, port = standInsPort()): Promise<Server> {
  const server = createServer(slackStandInHandler(deps));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
