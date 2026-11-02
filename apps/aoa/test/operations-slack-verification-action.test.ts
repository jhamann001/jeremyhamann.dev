import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, create, requestHeaders } = vi.hoisted(() => ({
  auth: vi.fn(), create: vi.fn(), requestHeaders: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("next/headers", () => ({ headers: requestHeaders }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/data/operations-slack-verification", () => ({ createOperationsSlackVerification: create }));
import { confirmOperationsSlackVerification } from "@/app/(authenticated)/operations/notification-verification/actions";
import { OPERATIONS_SLACK_VERIFICATION_REQUEST_ID } from "@/lib/operations/operations-slack-verification";
import { buildOperationsSlackMessage } from "@/lib/slack/operations-fee-notifications";

const session = () => ({ user: { role: "ADMIN", email: "synthetic@example.test" }, navigationScope: "synthetic", expires: new Date(Date.now() + 60_000).toISOString() });
const confirmation = () => {
  const form = new FormData();
  form.set("confirm", OPERATIONS_SLACK_VERIFICATION_REQUEST_ID);
  return form;
};
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue(session());
  requestHeaders.mockResolvedValue(new Headers({ "sec-fetch-site": "same-origin" }));
  create.mockResolvedValue(OPERATIONS_SLACK_VERIFICATION_REQUEST_ID);
});

describe("one-time Operations Slack test confirmation", () => {
  it("requires explicit confirmation and uses only the authenticated identity", async () => {
    await expect(confirmOperationsSlackVerification(confirmation())).rejects.toThrow("?result=recorded");
    expect(create).toHaveBeenCalledExactlyOnceWith({ role: "ADMIN", email: "synthetic@example.test" });
  });
  it("blocks cross-site requests before session or write access", async () => {
    requestHeaders.mockResolvedValue(new Headers({ "sec-fetch-site": "cross-site" }));
    await expect(confirmOperationsSlackVerification(confirmation())).rejects.toThrow("?result=denied");
    expect(auth).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it.each([null, { ...session(), user: { role: "VIEWER", email: "synthetic@example.test" } }, { ...session(), user: { role: "ADMIN", email: " " } }, { ...session(), navigationScope: "" }, { ...session(), expires: "invalid" }, { ...session(), expires: "2020-01-01T00:00:00Z" }])("denies absent or invalid authentication metadata", async (value) => {
    auth.mockResolvedValue(value);
    await expect(confirmOperationsSlackVerification(confirmation())).rejects.toThrow("?result=denied");
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["absent", "other-id", "duplicate", "recipient", "message"])("rejects %s form input without a write", async (variant) => {
    const form = confirmation();
    if (variant === "absent") form.delete("confirm");
    else if (variant === "other-id") form.set("confirm", "other-test");
    else if (variant === "duplicate") form.append("confirm", OPERATIONS_SLACK_VERIFICATION_REQUEST_ID);
    else form.set(variant, "not-permitted");
    await expect(confirmOperationsSlackVerification(form)).rejects.toThrow("?result=denied");
    expect(create).not.toHaveBeenCalled();
  });
  it("does not retry or reflect private errors after an ambiguous mutation failure", async () => {
    create.mockRejectedValue(new Error("private synthetic error"));
    await expect(confirmOperationsSlackVerification(confirmation())).rejects.toThrow("?result=unavailable");
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("makes the reserved test unmistakable with a fixed destination page", () => {
    expect(buildOperationsSlackMessage("SERVICE_GUARANTEE", OPERATIONS_SLACK_VERIFICATION_REQUEST_ID)).toBe(
      "TEST — AOA Operations notification verification.\n"
      + "No action required. This is a synthetic test; no client, fee, credit, waiver, or billing action is requested.\n"
      + "Test ID: ops195-test-notification-20260926\n"
      + "Review test in AOA: https://aoa.jeremyhamann.dev/operations/notification-verification",
    );
    expect(() => buildOperationsSlackMessage("FEE_CREDIT", OPERATIONS_SLACK_VERIFICATION_REQUEST_ID)).toThrow();
  });
  it("preserves the previously approved ordinary request message", () => {
    expect(buildOperationsSlackMessage("FEE_CREDIT", "synthetic-request-ordinary")).toBe(
      "New fee credit request — pending review.\nRequest ID: synthetic-request-ordinary\n"
      + "Review in AOA: https://aoa.jeremyhamann.dev/operations/fee-requests?request=synthetic-request-ordinary#request-synthetic-request-ordinary",
    );
  });
});
