import { describe, expect, it } from "vitest";
import {
  EMAIL_RE,
  CEDAR_RIDGE_USER_ID_RE,
  isValidIsoDate,
  validateAccountsItem,
  validateClientsItem,
  validateCrmParentOrphanItem,
  validateCrmParentItem,
  validateEnvelope,
  validateZendeskTicketsItem,
} from "../../lib/ingest/validate";

// Pure validator tests (no DB). All ids/emails are synthetic. A valid
// cedar_ridge_user_id is `user-` + 36 chars of [0-9a-f-].
const UID = "user-00000000-0000-0000-0000-00000000000n".replace("n", "0");
const UID2 = "user-00000000-0000-0000-0000-000000000002";

function validClient(over: Record<string, unknown> = {}) {
  return {
    cedar_ridge_user_id: UID,
    sf_contact_id: "TEST-D2-C1",
    name: "Daniel Chen",
    household_name: "Chen Household",
    household_sf_id: "TEST-D2-HH1",
    stage: "Prospect",
    lead_advisor_email: "avery@example.com",
    ...over,
  };
}
function validAccount(over: Record<string, unknown> = {}) {
  return {
    custodian_account_id: "ACCT-D2-1",
    cedar_ridge_user_id: UID,
    custodian: "APEX",
    account_type: "INDIVIDUAL",
    status: "OPEN",
    opened_at: "2026-01-15",
    closed_at: null,
    ...over,
  };
}

describe("regexes", () => {
  it("CEDAR_RIDGE_USER_ID_RE accepts a 36-char user- id, rejects junk", () => {
    expect(CEDAR_RIDGE_USER_ID_RE.test(UID)).toBe(true);
    expect(CEDAR_RIDGE_USER_ID_RE.test("user-tooshort")).toBe(false);
    expect(CEDAR_RIDGE_USER_ID_RE.test("nope")).toBe(false);
  });
  it("EMAIL_RE is a permissive x@y.z check", () => {
    expect(EMAIL_RE.test("a@b.co")).toBe(true);
    expect(EMAIL_RE.test("no-at-sign")).toBe(false);
    expect(EMAIL_RE.test("a@b")).toBe(false);
  });
  it("isValidIsoDate round-trips real calendar dates", () => {
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2026-02-30")).toBe(false); // not a real date
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-1-1")).toBe(false); // shape
  });
});

describe("validateEnvelope", () => {
  it("accepts { source, run_id, items[] }", () => {
    const r = validateEnvelope({ source: "s", run_id: "r", items: [] });
    expect(r.ok).toBe(true);
  });
  it("rejects non-object / non-string source / missing items", () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope([]).ok).toBe(false);
    expect(validateEnvelope({ source: 1, run_id: "r", items: [] }).ok).toBe(false);
    expect(validateEnvelope({ source: "s", run_id: "r" }).ok).toBe(false);
    expect(validateEnvelope({ source: "s", run_id: "r", items: "x" }).ok).toBe(false);
  });
  it("does NOT enforce the 5000 cap (handler's job)", () => {
    const big = { source: "s", run_id: "r", items: new Array(6000).fill({}) };
    expect(validateEnvelope(big).ok).toBe(true);
  });
});

describe("validateZendeskTicketsItem — content and privacy boundary", () => {
  const valid = {
    zendesk_ticket_id: "40290",
    requester_id: "12345",
    requester_cedar_ridge_user_id: UID,
    requester_email: "client@example.com",
    subject: "Account question",
    description: "Initial request",
    status: "open",
    priority: "normal",
    ticket_type: "question",
    ticket_url: "https://example.zendesk.com/agent/tickets/40290",
    created_at: "2026-08-28T12:00:00Z",
    updated_at: "2026-08-28T13:00:00Z",
    comments_truncated: false,
    comments: [{
      zendesk_comment_id: "90001",
      author_id: "12345",
      public: true,
      body: "Please help with this account.",
      created_at: "2026-08-28T12:00:00Z",
    }],
  };

  it("accepts an initial request and public comments", () => {
    expect(validateZendeskTicketsItem(valid, 0)).toBeNull();
  });

  it("rejects private comments and unknown fields", () => {
    expect(validateZendeskTicketsItem({
      ...valid,
      comments: [{ ...valid.comments[0], public: false }],
    }, 2)).toEqual({ index: 2, reason: "comments_invalid" });
    expect(validateZendeskTicketsItem({ ...valid, requester_name: "PII" }, 3))
      .toEqual({ index: 3, reason: "item_malformed" });
  });

  it("requires the safe Zendesk agent URL for the same ticket", () => {
    expect(validateZendeskTicketsItem({
      ...valid,
      ticket_url: "https://attacker.example/agent/tickets/40290",
    }, 4)).toEqual({ index: 4, reason: "ticket_url_invalid" });
    expect(validateZendeskTicketsItem({
      ...valid,
      ticket_url: "https://example.zendesk.com/agent/tickets/40290/extra",
    }, 5)).toEqual({ index: 5, reason: "ticket_url_invalid" });
    expect(validateZendeskTicketsItem({
      ...valid,
      ticket_url: "https://example.zendesk.com/agent/tickets/40290/",
    }, 6)).toBeNull();
  });
});

describe("validateClientsItem — TDD §7 order, first-failure-wins", () => {
  it("valid item → null", () => {
    expect(validateClientsItem(validClient(), 0)).toBeNull();
  });
  it("null cedar_ridge_user_id is allowed (nullable on clients)", () => {
    expect(validateClientsItem(validClient({ cedar_ridge_user_id: null }), 0)).toBeNull();
  });
  it("null household_sf_id → household_name not required", () => {
    const item = validClient({ household_sf_id: null, household_name: null });
    expect(validateClientsItem(item, 0)).toBeNull();
  });

  const cases: Array<[string, Record<string, unknown> | unknown, string]> = [
    ["item_malformed", "not-an-object", "item_malformed"],
    ["sf_contact_id_missing", validClient({ sf_contact_id: "" }), "sf_contact_id_missing"],
    ["name_missing", validClient({ name: "" }), "name_missing"],
    ["stage_missing", validClient({ stage: "" }), "stage_missing"],
    ["cedar_ridge_user_id_invalid", validClient({ cedar_ridge_user_id: "bad" }), "cedar_ridge_user_id_invalid"],
    ["household_name_missing", validClient({ household_sf_id: "HH", household_name: null }), "household_name_missing"],
    ["lead_advisor_email_invalid", validClient({ lead_advisor_email: "nope" }), "lead_advisor_email_invalid"],
  ];
  it.each(cases)("%s", (_label, item, reason) => {
    const r = validateClientsItem(item, 3);
    expect(r).toEqual({ index: 3, reason });
  });

  it("first-failure-wins: missing sf_contact_id beats a bad email", () => {
    const item = validClient({ sf_contact_id: "", lead_advisor_email: "nope" });
    expect(validateClientsItem(item, 0)).toEqual({ index: 0, reason: "sf_contact_id_missing" });
  });
});

describe("validateAccountsItem — TDD §7 order", () => {
  it("valid item → null", () => {
    expect(validateAccountsItem(validAccount(), 0)).toBeNull();
  });
  it("CLOSED with a closed_at is fine", () => {
    expect(
      validateAccountsItem(validAccount({ status: "CLOSED", closed_at: "2026-06-01" }), 0),
    ).toBeNull();
  });

  const cases: Array<[string, unknown, string]> = [
    ["item_malformed", 42, "item_malformed"],
    ["custodian_account_id_missing", validAccount({ custodian_account_id: "" }), "custodian_account_id_missing"],
    ["cedar_ridge_user_id_invalid (required here)", validAccount({ cedar_ridge_user_id: null }), "cedar_ridge_user_id_invalid"],
    ["custodian_invalid", validAccount({ custodian: "SCHWAB" }), "custodian_invalid"],
    ["status_invalid", validAccount({ status: "PENDING", closed_at: null }), "status_invalid"],
    ["opened_at_invalid", validAccount({ opened_at: "2026-13-40" }), "opened_at_invalid"],
    ["closed_at_invalid", validAccount({ status: "CLOSED", closed_at: "not-a-date" }), "closed_at_invalid"],
    ["status_closed_at_mismatch", validAccount({ status: "OPEN", closed_at: "2026-06-01" }), "status_closed_at_mismatch"],
  ];
  it.each(cases)("%s", (_label, item, reason) => {
    const r = validateAccountsItem(item, 2);
    expect(r).toEqual({ index: 2, reason });
  });
});

describe("validateCrmParentItem — typed Salesforce parent keys", () => {
  it.each([
    ["HOUSEHOLD", "001288867315530"],
    ["HOUSEHOLD", "001288867315530AAA"],
    ["CONTACT", "003288867315530"],
    ["CONTACT", "003288867315530AAA"],
  ])("accepts %s %s", (parent_type, source_key) => {
    expect(validateCrmParentItem({ parent_type, source_key }, 0)).toBeNull();
  });

  it.each([
    [null, "item_malformed"],
    [{ parent_type: "ACCOUNT", source_key: "001288867315530" }, "parent_type_invalid"],
    [{ parent_type: "HOUSEHOLD", source_key: "003288867315530" }, "source_key_invalid"],
    [{ parent_type: "CONTACT", source_key: "001288867315530" }, "source_key_invalid"],
    [{ parent_type: "HOUSEHOLD", source_key: "001-short" }, "source_key_invalid"],
    [{ parent_type: "CONTACT", source_key: 3 }, "source_key_invalid"],
  ])("rejects invalid parent input without echoing it", (item, reason) => {
    expect(validateCrmParentItem(item, 7)).toEqual({ index: 7, reason });
  });
});

describe("validateCrmParentOrphanItem — key-only historical evidence", () => {
  it.each([
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "DELETED" }],
    [{ parent_type: "CONTACT", source_key: "003288867315530AAA", parent_state: "DELETED", replacement_key: null }],
    [{
      parent_type: "HOUSEHOLD",
      source_key: "001288867315530AAA",
      parent_state: "MERGED",
      replacement_key: "001092155893454AAA",
    }],
  ])("accepts %o", (item) => {
    expect(validateCrmParentOrphanItem(item, 0)).toBeNull();
  });

  it.each([
    [null, "item_malformed"],
    [{ parent_type: "ACCOUNT", source_key: "001288867315530", parent_state: "DELETED" }, "parent_type_invalid"],
    [{ parent_type: "CONTACT", source_key: "001288867315530", parent_state: "DELETED" }, "source_key_invalid"],
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "ARCHIVED" }, "parent_state_invalid"],
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "MERGED", replacement_key: "003092155893454" }, "replacement_key_invalid"],
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "MERGED" }, "state_replacement_mismatch"],
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "DELETED", replacement_key: "001092155893454" }, "state_replacement_mismatch"],
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "MERGED", replacement_key: "001288867315530AAA" }, "state_replacement_mismatch"],
    [{ parent_type: "HOUSEHOLD", source_key: "001288867315530", parent_state: "DELETED", name: "must not cross seam" }, "item_malformed"],
  ])("rejects invalid evidence without echoing it: %o", (item, reason) => {
    expect(validateCrmParentOrphanItem(item, 4)).toEqual({ index: 4, reason });
  });
});
