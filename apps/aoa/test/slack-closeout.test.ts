import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import {
  SLACK_CLOSEOUT_TEMPLATE,
  isCloseoutComplete,
  mergeCloseoutItems,
  type SlackCloseoutItemRow,
} from "@/lib/data/slack-closeout-template";
import { postCloseoutWebhook } from "@/lib/slack/closeout-webhook";

// --- Template ---------------------------------------------------------------
describe("SLACK_CLOSEOUT_TEMPLATE", () => {
  it("is non-empty with unique item_keys and ascending sort", () => {
    expect(SLACK_CLOSEOUT_TEMPLATE.length).toBeGreaterThan(0);
    const keys = SLACK_CLOSEOUT_TEMPLATE.map((i) => i.item_key);
    expect(new Set(keys).size).toBe(keys.length); // item_key is the toggle key — must be unique
    const sorts = SLACK_CLOSEOUT_TEMPLATE.map((i) => i.sort);
    expect([...sorts].sort((a, b) => a - b)).toEqual(sorts);
  });
});

// --- Display merge (read-only card checklist) --------------------------------
describe("mergeCloseoutItems", () => {
  const row = (over: Partial<SlackCloseoutItemRow>): SlackCloseoutItemRow => ({
    item_key: "cost_basis_verified",
    label: "snapshot label",
    sort: 1,
    done: false,
    done_by: null,
    done_at: null,
    ...over,
  });

  it("attaches the template's label/group/note by item_key (template wins over the snapshot label)", () => {
    const merged = mergeCloseoutItems([
      row({ item_key: "trade_instructions_meridian", label: "old snapshot", sort: 7 }),
      row({ item_key: "cost_basis_verified", label: "old snapshot", sort: 1 }),
    ]);
    const alpha = merged.find((i) => i.item_key === "trade_instructions_meridian");
    expect(alpha?.label).toBe("Meridian");
    expect(alpha?.group).toBe("Trade Instructions");
    expect(alpha?.note).toContain("does NOT count");
    const basis = merged.find((i) => i.item_key === "cost_basis_verified");
    expect(basis?.label).toBe("Cost Basis Verified");
    expect(basis?.group).toBeUndefined();
    expect(basis?.note).toBeUndefined();
  });

  it("orders by template sort regardless of DB order (standalone first, then the group)", () => {
    const shuffled = [...SLACK_CLOSEOUT_TEMPLATE]
      .reverse()
      .map((t) => row({ item_key: t.item_key, sort: t.sort }));
    const merged = mergeCloseoutItems(shuffled);
    expect(merged.map((i) => i.item_key)).toEqual(
      SLACK_CLOSEOUT_TEMPLATE.map((t) => t.item_key),
    );
    // Grouped items are contiguous at the end — the card renders one header.
    const groups = merged.map((i) => i.group);
    expect(groups.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(groups.slice(3)).toEqual(Array(4).fill("Trade Instructions"));
  });

  it("unknown item_keys (template drift) keep the snapshot label and sort after every known item", () => {
    const merged = mergeCloseoutItems([
      row({ item_key: "retired_item", label: "Retired Item", sort: 1 }),
      row({ item_key: "trade_instructions_crm", sort: 6 }),
      row({ item_key: "cost_basis_verified", sort: 1 }),
    ]);
    expect(merged.map((i) => i.item_key)).toEqual([
      "cost_basis_verified",
      "trade_instructions_crm",
      "retired_item",
    ]);
    const retired = merged[2];
    expect(retired.label).toBe("Retired Item"); // seed-time snapshot, not item_key
    expect(retired.group).toBeUndefined();
    expect(retired.note).toBeUndefined();
  });

  it("falls back to item_key when an unknown row has a blank snapshot label", () => {
    const merged = mergeCloseoutItems([
      row({ item_key: "retired_item", label: "", sort: 9 }),
    ]);
    expect(merged[0].label).toBe("retired_item");
  });

  it("passes done/done_by/done_at through untouched (nulls included)", () => {
    const doneAt = new Date("2026-07-24T15:00:00Z");
    const merged = mergeCloseoutItems([
      row({
        item_key: "fee_reimbursement_filed",
        done: true,
        done_by: "riley@example.com",
        done_at: doneAt,
      }),
      row({ item_key: "cost_basis_verified" }),
    ]);
    const fee = merged.find((i) => i.item_key === "fee_reimbursement_filed");
    expect(fee).toMatchObject({
      done: true,
      done_by: "riley@example.com",
      done_at: doneAt,
    });
    const basis = merged.find((i) => i.item_key === "cost_basis_verified");
    expect(basis).toMatchObject({ done: false, done_by: null, done_at: null });
  });

  it("returns [] for no rows", () => {
    expect(mergeCloseoutItems([])).toEqual([]);
  });
});

// --- Completion rule --------------------------------------------------------
describe("isCloseoutComplete", () => {
  const REQUIRED = [
    "cost_basis_verified",
    "transition_template_applied",
    "fee_reimbursement_filed",
  ];
  it("complete when all standalone items done + Trade Center", () => {
    expect(isCloseoutComplete([...REQUIRED, "trade_instructions_trade_center"])).toBe(true);
  });
  it("complete when all standalone items done + CRM (Notewell NOT required)", () => {
    expect(isCloseoutComplete([...REQUIRED, "trade_instructions_crm"])).toBe(true);
  });
  it("NOT complete when Trade Instructions is only Meridian (never counts alone)", () => {
    expect(isCloseoutComplete([...REQUIRED, "trade_instructions_meridian"])).toBe(false);
  });
  it("NOT complete when Trade Instructions is only Notewell (never counts alone)", () => {
    expect(isCloseoutComplete([...REQUIRED, "notewell_notes_reviewed"])).toBe(false);
  });
  it("NOT complete when Trade Instructions is Notewell + Meridian (still no TC/CRM)", () => {
    expect(
      isCloseoutComplete([...REQUIRED, "notewell_notes_reviewed", "trade_instructions_meridian"]),
    ).toBe(false);
  });
  it("NOT complete when a standalone item is missing (even with Trade Center)", () => {
    expect(
      isCloseoutComplete([
        "cost_basis_verified",
        "transition_template_applied",
        "trade_instructions_trade_center",
      ]),
    ).toBe(false);
  });
  it("NOT complete for an empty set; Notewell/Meridian are fine as extras once TC/CRM is present", () => {
    expect(isCloseoutComplete([])).toBe(false);
    expect(
      isCloseoutComplete([
        ...REQUIRED,
        "trade_instructions_trade_center",
        "trade_instructions_meridian",
        "notewell_notes_reviewed",
      ]),
    ).toBe(true);
  });
});

// --- Outbound webhook -------------------------------------------------------
describe("postCloseoutWebhook", () => {
  const OLD = { ...process.env };
  const input = {
    transfer: {
      id: "T1",
      client_name: "Sam Stone",
      household_name: "Stone Family Trust",
      amount: 100,
      owner_kind: "OPERATIONS",
      owner_name: "Riley Ops",
    },
    checklist: [
      { item_key: "placeholder_1", label: "Placeholder item 1", sort: 1 },
      {
        item_key: "placeholder_2",
        label: "Placeholder item 2",
        sort: 2,
        group: "Trade Instructions",
        note: "Subscript shown under the row",
      },
    ],
  };

  afterEach(() => {
    process.env = { ...OLD };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("skips the POST when the webhook URL is unset", async () => {
    delete process.env.N8N_CLOSEOUT_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await postCloseoutWebhook(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a signed payload with callback_url derived from AUTH_URL (trailing slash trimmed)", async () => {
    process.env.N8N_CLOSEOUT_WEBHOOK_URL = "https://n8n.example/webhook/x";
    process.env.SLACK_CLOSEOUT_WEBHOOK_SECRET = "s3cr3t";
    process.env.AUTH_URL = "https://ops-portal-dev.example/";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await postCloseoutWebhook(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://n8n.example/webhook/x");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.event).toBe("transfer.in_transfer");
    expect(body.transfer.id).toBe("T1");
    expect(body.checklist).toHaveLength(2);
    // Display fields pass through on the wire — n8n needs them for the grouped
    // Slack render (group header + subscript note).
    expect(body.checklist[1].group).toBe("Trade Instructions");
    expect(body.checklist[1].note).toBe("Subscript shown under the row");
    expect(body.callback_url).toBe(
      "https://ops-portal-dev.example/api/ingest/slack-checklist",
    );
    const expectedSig = crypto
      .createHmac("sha256", "s3cr3t")
      .update(opts.body as string)
      .digest("hex");
    expect((opts.headers as Record<string, string>)["x-aoa-signature"]).toBe(
      expectedSig,
    );
  });

  it("never throws when the fetch fails (fire-and-forget, ADR-4)", async () => {
    process.env.N8N_CLOSEOUT_WEBHOOK_URL = "https://n8n.example/webhook/x";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(postCloseoutWebhook(input)).resolves.toBeUndefined();
  });
});

// --- Inbound callback guards (no DB — pre-scope paths only) ------------------
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ingest/scope", () => ({ withIngestScope: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  writeAudit: vi.fn(),
  TRANSFER_SLACK_CLOSEOUT: "transfer.slack_closeout",
}));
vi.mock("@/lib/ingest/auth", () => ({ requireIngestToken: vi.fn() }));

import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { POST } from "@/app/api/ingest/slack-checklist/route";

describe("POST /api/ingest/slack-checklist — guards", () => {
  afterEach(() => vi.clearAllMocks());

  const req = (body: unknown) =>
    new Request("https://ops-portal/api/ingest/slack-checklist", {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("401s without a valid token and never touches the scope", async () => {
    vi.mocked(requireIngestToken).mockReturnValue({ ok: false });
    const res = await POST(req({ type: "item", transfer_id: "T1", item_key: "k" }));
    expect(res.status).toBe(401);
    expect(withIngestScope).not.toHaveBeenCalled();
  });

  it("400s on invalid type / missing transfer_id / item without item_key (pre-scope)", async () => {
    vi.mocked(requireIngestToken).mockReturnValue({ ok: true });
    expect((await POST(req({ type: "nope", transfer_id: "T1" }))).status).toBe(400);
    expect((await POST(req({ type: "item" }))).status).toBe(400);
    // item toggle with no item_key → 400 (malformed body), not 404
    expect((await POST(req({ type: "item", transfer_id: "T1" }))).status).toBe(400);
    expect(withIngestScope).not.toHaveBeenCalled();
  });
});
