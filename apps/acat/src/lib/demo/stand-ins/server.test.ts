// @vitest-environment node
// Each integration's own client, unchanged, against its loopback stand-in.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDirectoryRows } from "@/lib/client-directory/source";
import { createFeeCreditRow, deleteFeeCreditRow, listFeeCreditRows } from "@/lib/fee-credit-store";
import { getAuthenticatedClient } from "@/lib/gcp-auth";
import { postToSlack, SlackWebhookError } from "@/lib/slack-webhook";
import { DIRECTORY_QUERY_FINGERPRINT } from "../directory";
import type { OutboxEntry } from "../outbox";
import { pipelineStatements } from "../statements";
import { loadUniverse } from "../universe";
import { startStandIns, type FeeStoreRow, type StandInDeps } from "./server";

const NOW = new Date("2026-10-27T14:00:00Z");
const universe = loadUniverse();
let server: Server;
let base: string;
let feeRows: FeeStoreRow[];
let outbox: OutboxEntry[];

const deps: StandInDeps = {
  universe: () => universe,
  now: () => NOW,
  recordOutbox: async (entry) => void outbox.push(entry),
  feeRows: {
    async list(filter) {
      return feeRows.filter((r) => (filter.client_name === undefined || r.client_name === filter.client_name)
        && (filter.account_numbers === undefined || r.account_numbers === filter.account_numbers));
    },
    async create(row) {
      const created = { ...row, id: 1000 + feeRows.length + 1 };
      feeRows.push(created);
      return created;
    },
    async remove(id) {
      const index = feeRows.findIndex((r) => r.id === id);
      return index < 0 ? null : feeRows.splice(index, 1)[0];
    },
  },
};

beforeAll(async () => {
  server = await startStandIns(deps, 0);
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  vi.stubEnv("DEMO_STAND_INS", "on");
  vi.stubEnv("STAND_INS_PORT", String(port));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  feeRows = [];
  outbox = [];
});

describe("fee store stand-in", () => {
  beforeEach(() => {
    vi.stubEnv("FEE_STORE_API_KEY", "demo-fee-key");
    vi.stubEnv("FEE_STORE_DB_URL", `${base}/fee-store`);
    vi.stubEnv("FEE_STORE_FEES_TABLE_ID", "fees");
  });

  it("creates, lists by account, and deletes rows through the app's client", async () => {
    const created = await createFeeCreditRow({ clientName: "Kofi Okafor & Ada Okafor", feeAmount: 75, accountNumber: "DEMO-142290" });
    expect(created).toMatchObject({ ok: true, status: 201 });
    const row = (created as { body: { data: FeeStoreRow[] } }).body.data[0];
    expect(row).toMatchObject({ client_name: "Kofi Okafor & Ada Okafor", fee_type: "ACAT Transfer Fee", fee_amount: 75, status: "Pending" });

    await createFeeCreditRow({ clientName: "Maeve Brennan", feeAmount: 95, accountNumber: "DEMO-191188" });
    const listed = await listFeeCreditRows({ accountNumber: "DEMO-142290" });
    expect(listed).toMatchObject({ ok: true, body: { data: [{ id: row.id }] } });

    expect(await deleteFeeCreditRow(String(row.id))).toMatchObject({ ok: true });
    expect(await listFeeCreditRows({ accountNumber: "DEMO-142290" })).toMatchObject({ ok: true, body: { data: [] } });
  });

  it("answers a store's own refusal (a demo cap) with its status and message", async () => {
    vi.spyOn(deps.feeRows, "create").mockRejectedValueOnce(Object.assign(new Error("The demo is full."), { status: 429 }));
    const res = await fetch(`${base}/fee-store/fees/rows`, {
      method: "POST",
      headers: { Authorization: "Bearer demo-fee-key", "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Maeve Brennan", fee_type: "ACAT Transfer Fee", fee_amount: 95, account_numbers: "DEMO-191188" }),
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ message: "The demo is full." });
  });

  it("answers a malformed path with 400 instead of throwing", async () => {
    const res = await fetch(`${base}/fee-store/%E0%A4%A/rows`, { headers: { Authorization: "Bearer demo-fee-key" } });
    expect(res.status).toBe(400);
  });

  // The app and its stand-in read the same settings, so a wrong credential is sent directly.
  it("refuses a wrong API key and an unknown table", async () => {
    const wrongKey = await fetch(`${base}/fee-store/fees/rows`, { headers: { Authorization: "Bearer wrong" } });
    expect(wrongKey.status).toBe(401);
    const otherTable = await fetch(`${base}/fee-store/other/rows`, { headers: { Authorization: "Bearer demo-fee-key" } });
    expect(otherTable.status).toBe(404);
  });
});

describe("warehouse stand-in (client directory)", () => {
  beforeEach(() => {
    vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_URL", `${base}/warehouse`);
    vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_API_KEY", "demo-warehouse-key");
    vi.stubEnv("CLIENT_DIRECTORY_WAREHOUSE_CARD_ID", "101");
    vi.stubEnv("CLIENT_DIRECTORY_QUERY_FINGERPRINT", DIRECTORY_QUERY_FINGERPRINT);
  });

  it("serves a complete directory snapshot the real parser accepts", async () => {
    const snapshot = await fetchDirectoryRows();
    expect(snapshot.sourceHealth).toBe("FRESH");
    expect(snapshot.clients).toHaveLength(universe.people.length);
    expect(snapshot.accounts).toHaveLength(universe.accounts.length);
    expect(snapshot.memberships.length).toBeGreaterThan(universe.accounts.length);
  });

  it("refuses a wrong key, and plain http once stand-ins are off", async () => {
    const wrongKey = await fetch(`${base}/warehouse/api/card/101/query/json`, { method: "POST", headers: { "x-api-key": "wrong" } });
    expect(wrongKey.status).toBe(401);
    vi.stubEnv("DEMO_STAND_INS", "off");
    await expect(fetchDirectoryRows()).rejects.toMatchObject({ code: "SOURCE_NOT_CONFIGURED" });
    vi.stubEnv("DEMO_STAND_INS", "on");
  });
});

describe("statement pipeline stand-in", () => {
  it("returns a statement's positions by account number and by id", async () => {
    const statement = pipelineStatements(universe, NOW).find((s) => s.client_name.includes("Okafor"))!;
    const client = await getAuthenticatedClient(base);
    const byNumber = await client.request<{ id: string; positions: unknown[] }>({ url: `${base}/api/v1/positions?account_number=${statement.account_number}` });
    expect(byNumber.status).toBe(200);
    expect(byNumber.data.positions).toHaveLength(statement.positions.length);
    const byId = await client.request<{ account_number: string }>({ url: `${base}/api/v1/positions?account_id=${byNumber.data.id}` });
    expect(byId.data.account_number).toBe(statement.account_number);
  });

  it("searches accounts by client name, and reports unknown accounts as 404", async () => {
    const client = await getAuthenticatedClient(base);
    const found = await client.request<{ accounts: Array<{ client_name: string }> }>({ url: `${base}/api/v1/position-accounts?q=okafor` });
    expect(found.data.accounts.some((a) => a.client_name.includes("Okafor"))).toBe(true);
    await expect(client.request({ url: `${base}/api/v1/positions?account_number=NOPE-0000` })).rejects.toMatchObject({ response: { status: 404 } });
  });

  it("refuses a caller without the stand-in token", async () => {
    const res = await fetch(`${base}/api/v1/positions?account_number=X`);
    expect(res.status).toBe(401);
  });
});

describe("Slack webhook stand-in", () => {
  it("keeps the message in the Outbox instead of sending it", async () => {
    vi.stubEnv("SLACK_WEBHOOK_URL", `${base}/slack/services/T0DEMO/B0DEMO/secret`);
    await postToSlack({ text: "Transfer Tracker daily status: 12 active", blocks: [{ type: "header" }] });
    expect(outbox).toEqual([expect.objectContaining({ transport: "slack", destination: "#transfers", title: "Transfer Tracker daily status: 12 active" })]);
  });

  it("answers an unknown webhook path the way Slack does", async () => {
    await expect(postToSlack({ text: "hi" }, { webhookUrl: `${base}/slack/services/T0DEMO/B0DEMO/wrong` })).rejects.toBeInstanceOf(SlackWebhookError);
    expect(outbox).toEqual([]);
  });
});
