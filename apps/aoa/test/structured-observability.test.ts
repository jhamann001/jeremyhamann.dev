import { describe, expect, it, vi } from "vitest";
import {
  buildAuthFailureLogEntry,
  buildDetailTimingLogEntry,
  buildDirectoryTimingLogEntry,
  buildIngestSuccessLogEntry,
  INGEST_FRESHNESS_ENDPOINTS,
  logAuthFailure,
  logDetailTiming,
  logDirectoryFailure,
  logDirectoryTiming,
  logIngestSuccess,
} from "@/lib/observability/structured-log";

describe("privacy-preserving structured observability", () => {
  it("emits a stable authentication failure without exception details", () => {
    const error = Object.assign(
      new Error("token=secret user=person@example.com"),
      {
        type: "OAuthCallbackError",
        cause: { access_token: "do-not-log" },
      },
    );

    expect(buildAuthFailureLogEntry(error)).toEqual({
      severity: "ERROR",
      message: "Authentication operation failed",
      event: "auth.failure",
      component: "auth",
      error_type: "OAuthCallbackError",
    });
    expect(JSON.stringify(buildAuthFailureLogEntry(error))).not.toMatch(
      /secret|person@|access_token|do-not-log/,
    );
  });

  it("bounds an unsafe authentication error type", () => {
    expect(
      buildAuthFailureLogEntry({
        type: "bad\nlabel person@example.com",
        message: "secret",
      }).error_type,
    ).toBe("AuthError");
  });

  it("logs authentication failures as one JSON line", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logAuthFailure({ type: "CredentialsSignin" });

    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toEqual(
      buildAuthFailureLogEntry({ type: "CredentialsSignin" }),
    );
    spy.mockRestore();
  });

  it("defines only scheduled data feeds as freshness signals", () => {
    expect(INGEST_FRESHNESS_ENDPOINTS).toEqual([
      "accounts",
      "activity",
      "appointments",
      "clients",
      "crm-parents",
      "deals",
      "emails",
      "schwab-account-balances",
      "tasks",
      "zendesk-tickets",
    ]);
    expect(INGEST_FRESHNESS_ENDPOINTS).not.toContain("slack-checklist");
    expect(INGEST_FRESHNESS_ENDPOINTS).not.toContain("crm-parent-orphans");
  });

  it("logs a successful committed feed without source data or run ids", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logIngestSuccess("accounts");

    const record = JSON.parse(String(spy.mock.calls[0][0]));
    expect(record).toEqual(buildIngestSuccessLogEntry("accounts"));
    expect(JSON.stringify(record)).not.toMatch(/run_id|source|received|upserted/);
    spy.mockRestore();
  });

  it("logs bounded directory timing without filters or record identity", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logDirectoryTiming("households", 123.6, 100);

    const record = JSON.parse(String(spy.mock.calls[0][0]));
    expect(record).toEqual(buildDirectoryTimingLogEntry("households", 123.6, 100));
    expect(record).toEqual({
      severity: "INFO",
      message: "Directory query completed",
      event: "directory.query",
      component: "directory",
      directory: "households",
      duration_ms: 124,
      returned_rows: 100,
    });
    expect(record).not.toHaveProperty("filters");
    expect(record).not.toHaveProperty("email");
    expect(record).not.toHaveProperty("sf_id");
    spy.mockRestore();
  });

  it("classifies directory failures without logging SQL or identity", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logDirectoryFailure("households_preview", 40.6, {
      code: "P2010", meta: { code: "57014", query: "person@example.invalid" },
      message: "person@example.invalid search=private",
    });
    const line = String(spy.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({
      severity: "ERROR", message: "Directory query failed", event: "directory.failure",
      component: "directory", directory: "households_preview", duration_ms: 41,
      category: "timeout",
    });
    expect(line).not.toMatch(/person@|search=|private/);
    spy.mockRestore();
  });

  it("logs bounded detail timing without client or household identity", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logDetailTiming("client_portrait", 987.6);

    const record = JSON.parse(String(spy.mock.calls[0][0]));
    expect(record).toEqual(buildDetailTimingLogEntry("client_portrait", 987.6));
    expect(record).toEqual({
      severity: "INFO",
      message: "Detail query completed",
      event: "detail.query",
      component: "detail",
      detail: "client_portrait",
      duration_ms: 988,
    });
    expect(record).not.toHaveProperty("email");
    expect(record).not.toHaveProperty("sf_id");
    expect(record).not.toHaveProperty("route");
    spy.mockRestore();
  });
});
