// The public demo (plan S3): persona sign-in fenced to the four personas, machine routes refused, outbound
// messages captured in the Outbox instead of sent, and the demo's flag set kept to what production runs.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { paused, executeRaw, queryRaw, fetchSpy } = vi.hoisted(() => ({
  paused: vi.fn(() => false),
  executeRaw: vi.fn(async () => 1),
  queryRaw: vi.fn(async () => [{ client_id: "user-request-client" }]),
  fetchSpy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: paused }));
vi.mock("@/lib/db", () => ({ prisma: { $executeRaw: executeRaw, $queryRaw: queryRaw } }));

import middleware from "@/middleware";
import { PERSONAS, canonicalPersonaEmail, devLoginEmail } from "@/lib/demo/personas";
import { slackSummary } from "@/lib/demo/outbox";
import { sendTradeRequestSlack } from "@/lib/slack/trade-requests";
import { postCloseoutWebhook } from "@/lib/slack/closeout-webhook";
import { captureOperationsSlackNotification } from "@/lib/data/operations-slack-capture";
import { NAV_GROUPS } from "@/components/shell/nav-config";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_LINKAGE_INSTALLATION_ID } from "@/lib/demo/stand-ins/tracker-linkage";

type RequestShape = { nextUrl: URL; auth: unknown; method: string };
const run = middleware as unknown as (request: RequestShape) => Response | undefined;
const request = (path: string, auth: unknown = null, method = "GET") =>
  ({ nextUrl: new URL(path, "https://example.test"), auth, method });

/** The values each tagged-template call to $executeRaw interpolated. */
const inserted = () => executeRaw.mock.calls.map((call) => (call as unknown[]).slice(1));

beforeEach(() => {
  executeRaw.mockClear();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("persona sign-in", () => {
  it("offers the universe's four staff, one per role", () => {
    const universe = JSON.parse(readFileSync(join(process.cwd(), "../../synthetic/out/universe.json"), "utf8")) as {
      staff: { name: string }[];
    };
    const staff = new Set(universe.staff.map((s) => s.name));
    expect(PERSONAS.map((p) => p.role).sort()).toEqual(["ADMIN", "ADVISOR", "CLIENT_SERVICE", "OPERATIONS"]);
    for (const p of PERSONAS) {
      expect(staff.has(p.name), p.name).toBe(true);
      expect(p.email).toBe(`${p.name.toLowerCase().replace(" ", ".")}@example.com`);
      expect(p.label.startsWith(`${p.name} · `)).toBe(true);
    }
  });

  it("matches a persona in any letter case and nothing else", () => {
    expect(canonicalPersonaEmail("  Rachel.Moss@EXAMPLE.com ")).toBe("rachel.moss@example.com");
    expect(canonicalPersonaEmail("rachel.moss@example.co")).toBeNull();
    expect(canonicalPersonaEmail("admin@example.com")).toBeNull();
  });

  it("signs in only as a persona while persona sign-in is on", () => {
    vi.stubEnv("PERSONA_SIGN_IN", "on");
    expect(devLoginEmail("Priya.Nair@example.com")).toBe("priya.nair@example.com");
    for (const other of ["admin@example.com", "ops@example.com", "", null, undefined, 42]) {
      expect(devLoginEmail(other), String(other)).toBeNull();
    }
  });

  it("keeps the local dev login's seeded users when it's off", () => {
    vi.stubEnv("PERSONA_SIGN_IN", "");
    expect(devLoginEmail("Admin@Example.com")).toBe("admin@example.com");
    expect(devLoginEmail("")).toBeNull();
  });

  it("routes the dev login through the fence", () => {
    const source = readFileSync(join(process.cwd(), "auth.ts"), "utf8");
    expect(source).toContain("const email = devLoginEmail(creds?.email);");
  });
});

describe("machine routes in the demo", () => {
  const machine = ["/api/ingest/clients", "/api/ingest/slack-checklist", "/api/cron/account-aum", "/api/cron/data-jobs",
    "/api/cron/health/aum-freshness", "/api/health/ai"];

  it("refuses ingest, cron and the AI probe before any handler, signed in or not", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    for (const path of machine) {
      for (const [auth, method] of [[null, "POST"], [{ user: {} }, "GET"]] as const) {
        const response = run(request(path, auth, method))!;
        expect(response.status, path).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    }
  });

  it("leaves the health check and the app's own routes alone", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    expect(run(request("/api/health"))).toBeUndefined();
    expect(run(request("/api/trade-requests/requests", { user: {} }))).toBeUndefined();
    expect(run(request("/command-center"))?.status).toBe(302);
  });

  it("changes nothing outside the demo", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    expect(run(request("/api/cron/data-jobs", null, "POST"))).toBeUndefined();
    expect(run(request("/api/ingest/clients", null, "POST"))).toBeUndefined();
  });
});

describe("the Outbox", () => {
  it("turns a Slack message into a title and a detail line", () => {
    expect(slackSummary("*New trade request* <https://x.example/r/1|REQ-1>\n• Okafor &amp; Co\n\n• $25,000"))
      .toEqual({ title: "New trade request REQ-1", detail: "• Okafor & Co · • $25,000" });
  });

  it("captures Trade Request Slack posts instead of calling Slack", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_SLACK", "1");
    await expect(sendTradeRequestSlack("channel", "*New request*\nOkafor Household", undefined, { requestId: "REQ-1" }))
      .resolves.toEqual({ status: "sent" });
    await expect(sendTradeRequestSlack({ user: "U123" }, "Approved", undefined, { cedarRidgeUserId: "user-exclusions" }))
      .resolves.toEqual({ status: "sent" });
    await expect(sendTradeRequestSlack("channel", "Daily digest")).resolves.toEqual({ status: "sent" });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Each post records the client it is about (a request's client is read from the request); the digest names none.
    expect(inserted()).toEqual([
      ["Slack", "#trade-requests", "New request", "Okafor Household", "*New request*\nOkafor Household", null, null, "user-request-client"],
      ["Slack", "Direct message", "Approved", "", "Approved", null, null, "user-exclusions"],
      ["Slack", "#trade-requests", "Daily digest", "", "Daily digest", null, null, null],
    ]);
  });

  it("still honors the Trade Request Slack switch", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("TRADE_REQUESTS_SLACK", "0");
    await expect(sendTradeRequestSlack("channel", "x")).resolves.toEqual({ status: "skipped" });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("captures the closeout checklist instead of posting to n8n", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("N8N_CLOSEOUT_WEBHOOK_URL", "https://n8n.example.test/webhook");
    await postCloseoutWebhook({
      transfer: { id: "T-1", client_name: "Kofi Okafor", household_name: "Okafor Household", amount: 412880,
        owner_kind: "ADVISOR", owner_name: "Rachel Moss" },
      checklist: [{ item_key: "a", label: "Confirm", sort: 1 }, { item_key: "b", label: "Close", sort: 2 }],
      about: { householdSfId: "001-household", clientSfId: "003-client" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const [[channel, destination, title, detail, body, ...about]] = inserted();
    expect(about).toEqual(["001-household", "003-client", null]);
    expect([channel, destination, title, detail]).toEqual(["Slack", "#transfers (via n8n)",
      "Closeout checklist sent for the Okafor Household transfer", "Kofi Okafor · $412,880 · 2 checklist items · Rachel Moss"]);
    expect(JSON.parse(String(body))).toMatchObject({ event: "transfer.in_transfer", transfer: { id: "T-1" } });
  });

  it("never throws from the closeout path when the Outbox write fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    executeRaw.mockRejectedValueOnce(new Error("synthetic"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(postCloseoutWebhook({
      transfer: { id: "T-1", client_name: "A", household_name: null, amount: 1, owner_kind: "ADVISOR", owner_name: null },
      checklist: [],
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[slack-closeout] outbox write failed err=Error");
  });

  it("captures an Operations alert in the submission's own transaction, not the delivery queue", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    const id = "cmabcdefghijklmnopqrstuvw";
    const tx = {
      $queryRaw: vi.fn(async () => [{ kind: "FEE_CREDIT", client_sf_id: "003-client" }]),
      $executeRaw: vi.fn(async () => 1),
    };
    await expect(captureOperationsSlackNotification(tx as never, id, 1n)).resolves.toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(sql.join("?")).toContain("INSERT INTO demo.outbox_message");
    expect(values.slice(0, 3)).toEqual(["Slack", "#operations", "New fee credit request — pending review."]);
    expect(values.slice(5)).toEqual([null, "003-client", null]);
  });

  it("adds the Outbox to the sidebar only in the demo", () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    expect(items.find((i) => i.href === "/outbox")).toMatchObject({ label: "Outbox", requiresDemo: true });
    expect(items.find((i) => i.href === "/outbox")?.requiredRoles).toBeUndefined();
  });
});

describe("the demo banner", () => {
  it("says what the demo is and links back to the portfolio, only in the demo", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("NEXT_PUBLIC_PORTFOLIO_URL", "https://jeremyhamann.dev");
    const html = renderToStaticMarkup(createElement(DemoBanner));
    expect(html).toContain("every person, account and record is invented");
    expect(html).toContain('href="https://jeremyhamann.dev/"');
    expect(html).toContain("Back to jeremyhamann.dev");
    vi.stubEnv("NEXT_PUBLIC_PORTFOLIO_URL", "http://jeremyhamann.dev");
    expect(renderToStaticMarkup(createElement(DemoBanner))).not.toContain("<a");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    expect(renderToStaticMarkup(createElement(DemoBanner))).toBe("");
  });
});

describe("the demo's settings", () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), "demo-config.json"), "utf8")) as Record<string, string>;
  const flagNames = new Set(
    [...readFileSync(join(process.cwd(), "lib/flags.ts"), "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
  );

  it("turns on the demo, persona sign-in and the way back to the portfolio", () => {
    expect(config).toMatchObject({
      NEXT_PUBLIC_DEMO_MODE: "on",
      PERSONA_SIGN_IN: "on",
      NEXT_PUBLIC_PORTFOLIO_URL: "https://jeremyhamann.dev",
    });
  });

  // Production's own settings, and the outside services' addresses, which the demo answers in-app (lib/demo/stand-ins).
  const settings: Record<string, string> = {
    APP_ENV: "prod",
    AOA_TRANSFER_FORMS_ENABLED: "true",
    TRANSFER_TRACKER_URL: "https://transfers.jeremyhamann.dev",
    STATEMENT_PIPELINE_URL: "https://statements.jeremyhamann.dev",
    TRANSFER_LINKAGE_URL: "https://transfers.jeremyhamann.dev",
    TRANSFER_LINKAGE_ENVIRONMENT: "production",
    TRANSFER_LINKAGE_INSTALLATION_ID: DEMO_LINKAGE_INSTALLATION_ID,
    WAREHOUSE_URL: "https://warehouse.example",
    WAREHOUSE_API_KEY: "demo-stand-in",
  };

  it("runs with production's settings, pointed at the in-app stand-ins", () => {
    expect(config).toMatchObject(settings);
  });

  it("sets only real feature flags, each to exactly 1", () => {
    const demoSwitches = new Set(["NEXT_PUBLIC_DEMO_MODE", "PERSONA_SIGN_IN", "NEXT_PUBLIC_PORTFOLIO_URL"]);
    for (const [key, value] of Object.entries(config)) {
      if (demoSwitches.has(key) || key in settings) continue;
      // The fast household directory is production's too, but read in its own module, not lib/flags.ts.
      expect(flagNames.has(key) || key === "HOUSEHOLD_DIRECTORY_FAST_PATH", key).toBe(true);
      expect(value, key).toBe("1");
    }
  });

  it("runs the Trade Requests workspace on its in-app backend, with its Slack captured", () => {
    for (const key of ["EPIC_TRADE_REQUESTS_WORKSPACE", "EPIC_TRADE_REQUESTS_BACKEND_MOVE", "TRADE_REQUESTS_NATIVE",
      "TRADE_REQUESTS_LOCAL_SOURCES", "TRADE_REQUESTS_SLACK", "ASSET_TRANSFER_WORKSPACE", "TRANSFER_PAPERWORK_RECORDS"]) {
      expect(config[key], key).toBe("1");
    }
  });

  it("keeps production-off features, scheduled jobs and dev-only switches off", () => {
    for (const key of ["AI_DRAFTING", "AI_MEETING_PREP", "SMART_NUDGES_REQUIREMENTS_RESOLVER", "CLIENT_PORTRAIT_EXPERIMENTS",
      "DATA_JOB_COLLECTION", "DATA_JOB_MONITORING", "TRADE_REQUESTS_DIGEST_JOB", "TRADE_REQUESTS_DRIFT_JOB",
      "REVIEW_QUEUE_SCHEDULER_ACTIVE", "TASKS_SAMPLE_ROWS", "AUTH_DEV_LOGIN", "ACAT_FIXTURE",
      "TRADE_REQUEST_FIXTURE", "INGEST_TOKEN", "AUTH_SECRET", "OPERATIONS_SLACK_CAPTURE_ENABLED",
      "OPERATIONS_SLACK_DELIVERY_ENABLED", "ROLLOUT_CUSTODIAN_CHANGE_DELIVERY_TKT404"]) {
      expect(config[key], key).toBeUndefined();
    }
  });
});
