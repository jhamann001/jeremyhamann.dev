import { describe, expect, it } from "vitest";
import { singleConnectionUrl, sourceDatabaseUrl } from "@/lib/trade-requests/cutover-connection";
import { parseCutoverArgs } from "../scripts/trade-requests/cutover";
import { JOB_COMMANDS, jobInvocation } from "../scripts/trade-requests/cutover-job";

const ENV = {
  DIRECT_DATABASE_URL: "postgresql://aoa_admin:pw@10.0.0.5:5432/aoa?schema=app",
  TRADE_REQUEST_SOURCE_DB_PASSWORD: "p@ss/w:rd",
  TRADE_REQUEST_SOURCE_DB_SOCKET: "/cloudsql/example-project:us-central1:trade-request-db",
};

describe("cutover job entry point", () => {
  it("allowlists exactly the copy, reconciliation, readiness and controller commands", () => {
    expect(Object.keys(JOB_COMMANDS).sort()).toEqual([
      "copy-change", "copy-full", "copy-report", "cutover", "handoff-digest-to-aoa", "handoff-digest-to-standalone",
      "handoff-drift-to-aoa", "handoff-drift-to-standalone", "preflight", "readiness", "reconcile", "recover", "retire", "rollback",
    ]);
    expect(JOB_COMMANDS["copy-full"]).toEqual(["scripts/trade-requests/copy.ts", "--mode=full"]);
    expect(JOB_COMMANDS.rollback).toEqual(["scripts/trade-requests/cutover.ts", "rollback"]);
  });

  it("refuses unknown commands, extra arguments and inherited object keys", () => {
    for (const argv of [[], ["copy-back"], ["cutover", "--now"], ["toString"], ["constructor"]]) {
      expect(jobInvocation(argv, ENV)).toHaveProperty("error");
    }
    expect(jobInvocation(["preflight"], {})).toEqual({ error: "DIRECT_DATABASE_URL is required" });
  });

  it("caps both databases at one never-recycled connection and never passes the raw source password on", () => {
    const inv = jobInvocation(["copy-change"], ENV);
    if ("error" in inv) throw new Error(inv.error);
    expect(inv.script).toBe("scripts/trade-requests/copy.ts");
    expect(inv.args).toEqual(["--mode=change"]);
    expect(inv.env.DIRECT_DATABASE_URL).toBe("postgresql://aoa_admin:pw@10.0.0.5:5432/aoa?schema=app&connection_limit=1&max_idle_connection_lifetime=0");
    expect(inv.env.TRADE_REQUEST_SOURCE_DATABASE_URL).toBe(
      "postgresql://trade_request_aoa_copy:p%40ss%2Fw%3Ard@localhost/trade_request?host=/cloudsql/example-project:us-central1:trade-request-db&connection_limit=1&max_idle_connection_lifetime=0",
    );
    expect(inv.env.TRADE_REQUEST_SOURCE_DB_PASSWORD).toBeUndefined();
  });

  it("replaces an existing connection limit and idle lifetime and adds both to a bare URL", () => {
    expect(singleConnectionUrl("postgresql://a@h/db?connection_limit=5&schema=app&max_idle_connection_lifetime=300")).toBe(
      "postgresql://a@h/db?schema=app&connection_limit=1&max_idle_connection_lifetime=0",
    );
    expect(singleConnectionUrl("postgresql://a@h/db")).toBe("postgresql://a@h/db?connection_limit=1&max_idle_connection_lifetime=0");
    expect(sourceDatabaseUrl("x", "/cloudsql/i")).toBe(
      "postgresql://trade_request_aoa_copy:x@localhost/trade_request?host=/cloudsql/i&connection_limit=1&max_idle_connection_lifetime=0",
    );
  });
});

describe("cutover command arguments", () => {
  it("accepts each command and the four handoffs, and nothing else", () => {
    for (const c of ["preflight", "cutover", "retire", "rollback", "recover"]) expect(parseCutoverArgs([c])).toEqual({ command: c });
    expect(parseCutoverArgs(["handoff", "--kind=drift", "--to=aoa"])).toEqual({ command: "handoff", kind: "drift", to: "aoa" });
    for (const argv of [[], ["switch"], ["cutover", "x"], ["handoff", "--kind=digest"], ["handoff", "--kind=email", "--to=aoa"], ["handoff", "--kind=digest", "--to=both"]]) {
      expect(parseCutoverArgs(argv)).toBeNull();
    }
  });
});
