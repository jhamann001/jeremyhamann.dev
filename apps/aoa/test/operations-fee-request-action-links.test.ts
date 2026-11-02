import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, previewSpy, createSpy, transitionSpy, revalidateSpy, redirectSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  previewSpy: vi.fn(),
  createSpy: vi.fn(),
  transitionSpy: vi.fn(),
  revalidateSpy: vi.fn(),
  redirectSpy: vi.fn((_path: string) => { throw new Error("REDIRECT"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/flags", () => ({ operationsFeeRequestsPreviewEnabled: previewSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));
vi.mock("@/lib/data/operations-fee-requests", () => ({
  createOperationsFeeRequest: createSpy,
  searchOperationsFeeClientOptions: vi.fn(),
  transitionOperationsFeeRequest: transitionSpy,
}));

import { submitOperationsFeeRequest, updateOperationsFeeRequest } from "@/app/(authenticated)/operations/fee-requests/actions";

const REQUEST_ID = "cmfee_older_selected_0001";
const IDENTITY = { role: "OPERATIONS", email: "operator@example.test" };

function workflowForm(requestId = REQUEST_ID) {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("workflowAction", "APPROVE");
  return form;
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "dev");
  vi.clearAllMocks();
  authSpy.mockResolvedValue({ user: IDENTITY });
  previewSpy.mockReturnValue(true);
  transitionSpy.mockResolvedValue("updated");
  createSpy.mockResolvedValue(REQUEST_ID);
});

afterEach(() => vi.unstubAllEnvs());

describe("Operations submission action binds the stable form key", () => {
  const submissionKey = "0f987ccf-55dd-4346-b8ef-1b30b128d210";
  function form() {
    const value = new FormData();
    value.set("requestKind", "FEE_CREDIT");
    value.set("clientSfId", "DEV-SYNTHETIC");
    value.set("accountIds", "synthetic-account");
    value.set("feeTypes", "Wire");
    value.set("feeAmount", "25.00");
    value.set("submissionKey", submissionKey);
    return value;
  }
  it("passes the same key to creation on repeated submissions and links to the saved request", async () => {
    for (let count = 0; count < 2; count++) await expect(submitOperationsFeeRequest(form())).rejects.toThrow("REDIRECT");
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenNthCalledWith(1, IDENTITY, expect.objectContaining({ clientSfId: "DEV-SYNTHETIC" }), submissionKey);
    expect(createSpy).toHaveBeenNthCalledWith(2, IDENTITY, expect.any(Object), submissionKey);
    expect(redirectSpy).toHaveBeenLastCalledWith(`/operations/fee-requests?message=submitted&request=${REQUEST_ID}#request-${REQUEST_ID}`);
  });
  it.each([null, "", "not-a-uuid", submissionKey + "\n"])("refuses missing or malformed keys before creation", async (key) => {
    const value = form();
    if (key === null) value.delete("submissionKey"); else value.set("submissionKey", key);
    await expect(submitOperationsFeeRequest(value)).rejects.toThrow("REDIRECT");
    expect(createSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenLastCalledWith("/operations/fee-requests?message=submission-failed");
  });
  it("refuses unauthorized actors before creation", async () => {
    authSpy.mockResolvedValue({ user: { ...IDENTITY, role: "VIEWER" } });
    await expect(submitOperationsFeeRequest(form())).rejects.toThrow("REDIRECT");
    expect(createSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenLastCalledWith("/");
  });

  it("rejects a forged DEV client even when the production feature gate is enabled", async () => {
    vi.stubEnv("APP_ENV", "prod");
    vi.stubEnv("OPERATIONS_PRODUCTION_ENABLED", "1");
    await expect(submitOperationsFeeRequest(form())).rejects.toThrow("REDIRECT");
    expect(createSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenLastCalledWith("/operations/fee-requests?message=submission-failed");
  });
});

describe("Operations review action retains the selected request", () => {
  it.each([
    ["updated", "workflow-updated"],
    ["conflict", "workflow-conflict"],
    ["invalid", "workflow-invalid"],
  ])("keeps the validated request link after a %s result", async (result, message) => {
    transitionSpy.mockResolvedValue(result);
    await expect(updateOperationsFeeRequest(workflowForm())).rejects.toThrow("REDIRECT");
    expect(transitionSpy).toHaveBeenCalledWith(IDENTITY, expect.objectContaining({ requestId: REQUEST_ID }));
    expect(revalidateSpy).toHaveBeenCalledExactlyOnceWith("/operations/fee-requests");
    expect(redirectSpy).toHaveBeenCalledExactlyOnceWith(`/operations/fee-requests?message=${message}&request=${REQUEST_ID}#request-${REQUEST_ID}`);
  });

  it("retains a parsed ID on an operational failure but exposes no error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      transitionSpy.mockRejectedValue(new Error("internal sensitive error detail"));
      await expect(updateOperationsFeeRequest(workflowForm())).rejects.toThrow("REDIRECT");
      expect(redirectSpy).toHaveBeenCalledExactlyOnceWith(`/operations/fee-requests?message=workflow-failed&request=${REQUEST_ID}#request-${REQUEST_ID}`);
      expect(log).toHaveBeenCalledExactlyOnceWith("[operations-fee-request] workflow_failed");
    } finally {
      log.mockRestore();
    }
  });

  it.each(["", "short", "https://attacker.example/", `${REQUEST_ID}&message=forged`, "<script>unsafe</script>"])(
    "does not reflect an invalid request ID: %j", async (value) => {
      await expect(updateOperationsFeeRequest(workflowForm(value))).rejects.toThrow("REDIRECT");
      expect(transitionSpy).not.toHaveBeenCalled();
      expect(redirectSpy).toHaveBeenCalledExactlyOnceWith("/operations/fee-requests?message=workflow-failed");
    },
  );

  it("uses the generic failure path if the complete workflow form cannot be validated", async () => {
    const form = workflowForm();
    form.set("workflowAction", "injected-action");
    await expect(updateOperationsFeeRequest(form)).rejects.toThrow("REDIRECT");
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenCalledExactlyOnceWith("/operations/fee-requests?message=workflow-failed");
  });

  it.each(["VIEWER", "ADVISOR", "CLIENT_SERVICE"])("does not preserve a submitted link for an unauthorized %s", async (role) => {
    authSpy.mockResolvedValue({ user: { ...IDENTITY, role } });
    await expect(updateOperationsFeeRequest(workflowForm())).rejects.toThrow("REDIRECT");
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(revalidateSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("does not preserve a submitted link without authentication", async () => {
    authSpy.mockResolvedValue(null);
    await expect(updateOperationsFeeRequest(workflowForm())).rejects.toThrow("REDIRECT");
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(redirectSpy).toHaveBeenCalledExactlyOnceWith("/");
  });
});
