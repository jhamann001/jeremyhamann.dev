/**
 * audit.ts unit tests (§g S2 tests).
 *
 * HARD GATE: the three fixture rows below were copied verbatim from rows the REAL `audit_log_chain()`
 * trigger produced in the local test database (wm_helpdesk_test, written through `writeAudit` /
 * `writeAuditMany` by db.integration.test.ts on 2026-09-17, read back with psql). They pin the 16-field
 * payload: `hashAuditRow(canonicalAuditPayload(row)) === row.hash` and `prevHash` linkage. Fixture 2 has two
 * `actorGroups` and a non-null, sanitized `userAgent`; fixture 1 and 3 carried `metadata` in the database
 * and still re-hash without it (metadata and id are outside the hash by contract).
 */
import { describe, expect, it } from "vitest";
import { OKTA_GROUPS } from "@/types/domain";
import type { OktaGroup, Viewer } from "@/types/domain";
import {
  AUDIT_VALUE_MAX_CHARS,
  SYSTEM_ACTOR,
  actorFromViewer,
  canonicalAuditPayload,
  clientApiActor,
  deniedEntityType,
  diffFields,
  hashAuditRow,
  prepareAuditMetadata,
  prepareAuditValue,
  prepareUserAgent,
  serializeAuditValue,
  sortGroups,
  systemRequestContext,
  verifyChainRows,
} from "@/lib/audit";
import type { AuditChainRow } from "@/lib/audit";

const FIXTURES: AuditChainRow[] = [
  {
    seq: BigInt(1),
    occurredAt: new Date("2026-09-17T02:12:16.159Z"),
    actorId: null,
    actorEmail: "system@wm-helpdesk.local",
    actorGroups: [],
    action: "AUDIT_CHAIN_VERIFIED",
    entityType: "AUDIT_LOG",
    entityId: null,
    ticketId: null,
    fieldChanged: null,
    oldValue: null,
    newValue: "OK",
    ipAddress: "unknown",
    userAgent: "it-system-58a9ecde",
    requestId: "it-system-58a9ecde-9be8cfa6-d57e-4cb2-b330-52191baefb46",
    prevHash: "GENESIS",
    hash: "20400d23764edca9d43b0bfdb129d075cbaf9103b524c7131d837ba5bd1bb142",
  },
  {
    seq: BigInt(2),
    occurredAt: new Date("2026-09-17T02:12:16.174Z"),
    actorId: "it_user_dual_role",
    actorEmail: "dual.role@wm-helpdesk.local",
    actorGroups: ["ops_team", "compliance_officers"],
    action: "TICKET_VIEWED",
    entityType: "TICKET",
    entityId: "it_ticket_isolation_probe",
    ticketId: "it_ticket_isolation_probe",
    fieldChanged: null,
    oldValue: null,
    newValue: null,
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0 (Macintosh; ssn [REDACTED:SSN]) AppleWebKit/537.36 it-run",
    requestId: "it-req-58a9ecde",
    prevHash: "20400d23764edca9d43b0bfdb129d075cbaf9103b524c7131d837ba5bd1bb142",
    hash: "e5381adfec38ca54401f750d4cd8d3eca13d9e838de6841feeefb6d756ef4940",
  },
  {
    seq: BigInt(3),
    occurredAt: new Date("2026-09-17T02:12:16.175Z"),
    actorId: "it_user_dual_role",
    actorEmail: "dual.role@wm-helpdesk.local",
    actorGroups: ["ops_team", "compliance_officers"],
    action: "TICKET_FIELD_CHANGED",
    entityType: "TICKET",
    entityId: "it_ticket_isolation_probe",
    ticketId: "it_ticket_isolation_probe",
    fieldChanged: "subject",
    oldValue: "Card [REDACTED:CARD ****1111] on file",
    newValue: "Card on file",
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0 (Macintosh; ssn [REDACTED:SSN]) AppleWebKit/537.36 it-run",
    requestId: "it-req-58a9ecde",
    prevHash: "e5381adfec38ca54401f750d4cd8d3eca13d9e838de6841feeefb6d756ef4940",
    hash: "4e0263d9b85c90700b7ec890112e9b013637ec2d3f4966cc1ef6583a941eaea5",
  },
];

const SEP = "\x1f";

describe("hash-chain parity with the database trigger (hard gate)", () => {
  it("every trigger-produced fixture re-hashes with canonicalAuditPayload", () => {
    for (const row of FIXTURES) {
      expect(hashAuditRow(canonicalAuditPayload(row))).toBe(row.hash);
    }
  });

  it("prevHash links each fixture to the previous row's hash, starting at GENESIS", () => {
    expect(FIXTURES[0].prevHash).toBe("GENESIS");
    expect(FIXTURES[1].prevHash).toBe(FIXTURES[0].hash);
    expect(FIXTURES[2].prevHash).toBe(FIXTURES[1].hash);
  });

  it("the fixtures cover an empty-group system actor and a two-group actor with a user agent", () => {
    expect(FIXTURES[0].actorGroups).toEqual([]);
    expect(FIXTURES[0].actorId).toBeNull();
    expect(FIXTURES[1].actorGroups).toHaveLength(2);
    expect(FIXTURES[1].userAgent).not.toBeNull();
    expect(FIXTURES[1].userAgent).toContain("[REDACTED:SSN]");
  });

  it("the payload is the 16 §e fields joined with \\x1f in trigger order", () => {
    const fields = canonicalAuditPayload(FIXTURES[1]).split(SEP);
    expect(fields).toHaveLength(16);
    expect(fields).toEqual([
      FIXTURES[1].prevHash,
      "2",
      "2026-09-17T02:12:16.174Z",
      "it_user_dual_role",
      "dual.role@wm-helpdesk.local",
      "TICKET_VIEWED",
      "TICKET",
      "it_ticket_isolation_probe",
      "it_ticket_isolation_probe",
      "",
      "",
      "",
      "203.0.113.7",
      "it-req-58a9ecde",
      "ops_team,compliance_officers",
      "Mozilla/5.0 (Macintosh; ssn [REDACTED:SSN]) AppleWebKit/537.36 it-run",
    ]);
    // Nulls become empty strings exactly like COALESCE(..., '').
    const nulls = canonicalAuditPayload(FIXTURES[0]).split(SEP);
    expect(nulls[3]).toBe("");
    expect(nulls[7]).toBe("");
    expect(nulls[14]).toBe("");
  });

  it("every hashed column changes the digest (nothing evidentiary is outside the hash)", () => {
    const base = FIXTURES[2];
    const mutations: Array<Partial<AuditChainRow>> = [
      { prevHash: "GENESIS" },
      { seq: BigInt(4) },
      { occurredAt: new Date(base.occurredAt.getTime() + 1) },
      { actorId: null },
      { actorEmail: "other@wm-helpdesk.local" },
      { action: "TICKET_VIEWED" },
      { entityType: "COMMENT" },
      { entityId: "x" },
      { ticketId: null },
      { fieldChanged: "description" },
      { oldValue: "Card on file" },
      { newValue: "Card [REDACTED:CARD ****1111] on file" },
      { ipAddress: "unknown" },
      { requestId: "other" },
      { actorGroups: ["ops_team"] },
      { actorGroups: ["compliance_officers", "ops_team"] },
      { userAgent: null },
    ];
    for (const m of mutations) {
      expect(hashAuditRow(canonicalAuditPayload({ ...base, ...m }))).not.toBe(base.hash);
    }
  });

  it("hashAuditRow is sha256 hex over UTF-8", () => {
    expect(hashAuditRow("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashAuditRow("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashAuditRow("é")).toBe(hashAuditRow("é"));
    expect(hashAuditRow("é")).not.toBe(hashAuditRow("e"));
  });
});

describe("verifyChainRows", () => {
  it("OK over the trigger fixtures from GENESIS", () => {
    expect(verifyChainRows(FIXTURES, null)).toEqual({ ok: true, checked: 3, firstBadSeq: null, reason: "OK" });
  });

  it("OK for a page that continues from a known previous hash", () => {
    expect(verifyChainRows(FIXTURES.slice(1), FIXTURES[0].hash)).toEqual({
      ok: true,
      checked: 2,
      firstBadSeq: null,
      reason: "OK",
    });
  });

  it("EMPTY for no rows", () => {
    expect(verifyChainRows([], null)).toEqual({ ok: true, checked: 0, firstBadSeq: null, reason: "EMPTY" });
    expect(verifyChainRows([], FIXTURES[0].hash).reason).toBe("EMPTY");
  });

  it("HASH_MISMATCH when a hashed column was altered", () => {
    const tampered = FIXTURES.map((r) => ({ ...r }));
    tampered[2].newValue = "Card on file (edited)";
    expect(verifyChainRows(tampered, null)).toEqual({
      ok: false,
      checked: 3,
      firstBadSeq: BigInt(3),
      reason: "HASH_MISMATCH",
    });
    const tamperedGroups = FIXTURES.map((r) => ({ ...r }));
    tamperedGroups[1].actorGroups = ["ops_team"];
    expect(verifyChainRows(tamperedGroups, null).reason).toBe("HASH_MISMATCH");
    expect(verifyChainRows(tamperedGroups, null).firstBadSeq).toBe(BigInt(2));
    const tamperedUa = FIXTURES.map((r) => ({ ...r }));
    tamperedUa[1].userAgent = "curl/8.0";
    expect(verifyChainRows(tamperedUa, null).reason).toBe("HASH_MISMATCH");
  });

  it("PREV_HASH_MISMATCH when the link is broken or the page does not start where expected", () => {
    const broken = FIXTURES.map((r) => ({ ...r }));
    broken[1].prevHash = "0".repeat(64);
    expect(verifyChainRows(broken, null)).toEqual({
      ok: false,
      checked: 2,
      firstBadSeq: BigInt(2),
      reason: "PREV_HASH_MISMATCH",
    });
    // A page that does not begin at GENESIS must be given the previous hash.
    expect(verifyChainRows(FIXTURES.slice(1), null)).toEqual({
      ok: false,
      checked: 1,
      firstBadSeq: BigInt(2),
      reason: "PREV_HASH_MISMATCH",
    });
    // A deleted row in the middle breaks the link of its successor.
    expect(verifyChainRows([FIXTURES[0], FIXTURES[2]], null).reason).toBe("PREV_HASH_MISMATCH");
    expect(verifyChainRows([FIXTURES[0], FIXTURES[2]], null).firstBadSeq).toBe(BigInt(3));
  });

  it("a row re-hashed after tampering still fails on its successor's prevHash", () => {
    const rehashed = FIXTURES.map((r) => ({ ...r }));
    rehashed[1].newValue = "slide-over";
    rehashed[1].hash = hashAuditRow(canonicalAuditPayload(rehashed[1]));
    const verdict = verifyChainRows(rehashed, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("PREV_HASH_MISMATCH");
    expect(verdict.firstBadSeq).toBe(BigInt(3));
  });
});

describe("value preparation (I4 — defense in depth)", () => {
  it("prepareAuditValue: null/undefined → null; redacts; truncates to AUDIT_VALUE_MAX_CHARS with a suffix", () => {
    expect(AUDIT_VALUE_MAX_CHARS).toBe(4000);
    expect(prepareAuditValue(null)).toBeNull();
    expect(prepareAuditValue(undefined)).toBeNull();
    expect(prepareAuditValue("")).toBe("");
    expect(prepareAuditValue("plain")).toBe("plain");
    expect(prepareAuditValue("SSN 123-45-6789 and card 4111 1111 1111 1111")).toBe(
      "SSN [REDACTED:SSN] and card [REDACTED:CARD ****1111]",
    );

    const exact = "a".repeat(4000);
    expect(prepareAuditValue(exact)).toBe(exact);

    const long = prepareAuditValue("b".repeat(5000));
    expect(long).toHaveLength(4000);
    expect(long!.endsWith("…[truncated]")).toBe(true);
    expect(long!.startsWith("bbbb")).toBe(true);

    // Sanitization happens before truncation, so raw digits never survive at the cut.
    const tail = prepareAuditValue(`${"c".repeat(3990)} SSN 123-45-6789`);
    expect(tail).toHaveLength(4000);
    expect(tail).not.toContain("123-45-6789");
  });

  it("prepareAuditMetadata: undefined passes through; nested strings are redacted; numbers/booleans survive", () => {
    expect(prepareAuditMetadata(undefined)).toBeUndefined();
    expect(
      prepareAuditMetadata({
        filters: { actorEmail: "a@b", note: "SSN 123-45-6789" },
        list: ["card 4111 1111 1111 1111", 3, true, null],
        count: 12,
        ok: false,
      }),
    ).toEqual({
      filters: { actorEmail: "a@b", note: "SSN [REDACTED:SSN]" },
      list: ["card [REDACTED:CARD ****1111]", 3, true, null],
      count: 12,
      ok: false,
    });
    expect(prepareAuditMetadata({ disclaimerKey: "WIRE_VERIFICATION" })).toEqual({ disclaimerKey: "WIRE_VERIFICATION" });
    expect(prepareAuditMetadata("ssn: 123456789")).toBe("ssn: [REDACTED:SSN]");
    expect(prepareAuditMetadata(42)).toBe(42);
  });

  it("prepareAuditMetadata never persists raw digits even when redaction breaks the JSON shape", () => {
    // A bare JSON number under an account key: the key supplies rule 4's context, the token replaces
    // the number, and the text no longer parses. This used to use `{ n: 121000248 }` and rely on the
    // ABA checksum; Decision #116 withdrew the routing rule, so the probe now leans on a rule that
    // still exists. The behaviour under test — the `unparseable` fallback keeps the redacted text
    // rather than the raw object — is unchanged.
    const out = prepareAuditMetadata({ acct: 121000248 });
    expect(JSON.stringify(out)).not.toContain("121000248");
    expect(out).toEqual({ unparseable: '{"acct":[REDACTED:ACCOUNT ****0248]}' });
  });

  it("prepareUserAgent: null/undefined/empty → null; redacts an embedded SSN; truncates to 512", () => {
    expect(prepareUserAgent(null)).toBeNull();
    expect(prepareUserAgent(undefined)).toBeNull();
    expect(prepareUserAgent("")).toBeNull();
    expect(prepareUserAgent("Mozilla/5.0 (X11; Linux) ssn 123-45-6789 Gecko")).toBe(
      "Mozilla/5.0 (X11; Linux) ssn [REDACTED:SSN] Gecko",
    );
    expect(prepareUserAgent("U".repeat(600))).toBe("U".repeat(512));
    const expanded = prepareUserAgent(`${"v".repeat(505)} SSN 123-45-6789`);
    expect(expanded).toHaveLength(512);
    expect(expanded).not.toContain("123-45-6789");
    expect(prepareUserAgent("curl/8.4.0")).toBe("curl/8.4.0");
  });
});

describe("row helpers", () => {
  it("sortGroups dedupes and orders per OKTA_GROUPS", () => {
    expect(sortGroups(["compliance_officers", "ops_team", "ops_team"])).toEqual(["ops_team", "compliance_officers"]);
    expect(sortGroups([...OKTA_GROUPS].reverse())).toEqual([...OKTA_GROUPS]);
    expect(sortGroups([])).toEqual([]);
    expect(sortGroups(["advisors"])).toEqual(["advisors"]);
    expect(sortGroups(["client_services", "advisors", "not_a_group" as OktaGroup])).toEqual(["advisors", "client_services"]);
  });

  it("deniedEntityType — verbatim rule", () => {
    expect(deniedEntityType("ticket:read PREVIEW", "t_1")).toBe("TICKET");
    expect(deniedEntityType("verifyAuditChain: Forbidden: audit:verify")).toBe("AUDIT_LOG");
    expect(deniedEntityType("audit:view", null)).toBe("AUDIT_LOG");
    expect(deniedEntityType("path:/queues/advice")).toBe("QUEUE");
    expect(deniedEntityType("path:/compliance/audit")).toBe("QUEUE");
    expect(deniedEntityType("ticket:create", null)).toBe("QUEUE");
    expect(deniedEntityType("audit:export", "t_1")).toBe("TICKET");
    expect(deniedEntityType("queue:read macros ADVICE", "")).toBe("QUEUE");
  });

  it("actors", () => {
    expect(SYSTEM_ACTOR).toEqual({ id: null, email: "system@wm-helpdesk.local", groups: [] });
    const viewer: Viewer = {
      id: "u1",
      email: "Olivia@wm-helpdesk.local",
      name: "Olivia",
      image: null,
      groups: ["ops_team"],
      isDev: true,
    };
    const actor = actorFromViewer(viewer);
    expect(actor).toEqual({ id: "u1", email: "Olivia@wm-helpdesk.local", groups: ["ops_team"] });
    expect(actor.groups).not.toBe(viewer.groups);
    expect(clientApiActor("Client@Example.COM")).toEqual({ id: null, email: "client:client@example.com", groups: [] });
    expect(clientApiActor("anonymous")).toEqual({ id: null, email: "client:anonymous", groups: [] });
  });

  it("systemRequestContext", () => {
    const ctx = systemRequestContext("seed");
    expect(ctx.ipAddress).toBe("unknown");
    expect(ctx.userAgent).toBe("seed");
    expect(ctx.isPrefetch).toBe(false);
    expect(ctx.requestId).toMatch(/^seed-[0-9a-f-]{36}$/);
    expect(systemRequestContext("seed").requestId).not.toBe(ctx.requestId);
  });

  it("serializeAuditValue", () => {
    expect(serializeAuditValue(null)).toBeNull();
    expect(serializeAuditValue(undefined)).toBeNull();
    expect(serializeAuditValue(new Date("2026-09-16T12:00:00.000Z"))).toBe("2026-09-16T12:00:00.000Z");
    expect(serializeAuditValue(new Date("invalid"))).toBe("Invalid Date");
    expect(serializeAuditValue(BigInt("9007199254740993"))).toBe("9007199254740993");
    expect(serializeAuditValue({ a: 1, b: [2, "x"] })).toBe('{"a":1,"b":[2,"x"]}');
    expect(serializeAuditValue(["ops_team"])).toBe('["ops_team"]');
    expect(serializeAuditValue("text")).toBe("text");
    expect(serializeAuditValue(3)).toBe("3");
    expect(serializeAuditValue(true)).toBe("true");
    expect(serializeAuditValue("NEW")).toBe("NEW");
  });

  it("diffFields emits one row per changed, provided field", () => {
    const before = {
      subject: "old subject",
      description: "same",
      clientReference: null as string | null,
      category: "OTHER",
      priority: "LOW",
      resolvedAt: null as Date | null,
      version: 3,
      count: BigInt(7),
    };
    const resolvedAt = new Date("2026-09-16T12:00:00.000Z");
    const after: Partial<typeof before> = {
      subject: "new subject",
      description: "same",
      clientReference: "HH-1042",
      category: undefined,
      resolvedAt,
      count: BigInt(8),
    };
    expect(diffFields(before, after, ["subject", "description", "clientReference", "category", "priority", "resolvedAt", "count"])).toEqual([
      { fieldChanged: "subject", oldValue: "old subject", newValue: "new subject" },
      { fieldChanged: "clientReference", oldValue: null, newValue: "HH-1042" },
      { fieldChanged: "resolvedAt", oldValue: null, newValue: "2026-09-16T12:00:00.000Z" },
      { fieldChanged: "count", oldValue: "7", newValue: "8" },
    ]);
    // Clearing to null is a change; an unchanged Date is not.
    expect(diffFields({ resolvedAt: resolvedAt as Date | null }, { resolvedAt: null }, ["resolvedAt"])).toEqual([
      { fieldChanged: "resolvedAt", oldValue: "2026-09-16T12:00:00.000Z", newValue: null },
    ]);
    expect(diffFields({ resolvedAt }, { resolvedAt: new Date(resolvedAt.getTime()) }, ["resolvedAt"])).toEqual([]);
    expect(diffFields(before, {}, ["subject"])).toEqual([]);
  });
});
