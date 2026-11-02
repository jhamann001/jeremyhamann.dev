import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/operations/legacy-import-job-runtime", async (original) => ({
  ...await original<typeof import("@/lib/operations/legacy-import-job-runtime")>(),
  executeLegacyImportJob: runtime.execute,
}));
import { LegacyImportJobRuntimeError } from "@/lib/operations/legacy-import-job-runtime";
import { legacyOperationsJobMain } from "../scripts/import-legacy-operations-job";

let originalExitCode: typeof process.exitCode;
beforeEach(() => { originalExitCode = process.exitCode; vi.clearAllMocks(); });
afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); });

describe("private importer entrypoint commit outcome", () => {
  it.each([
    [new Error("apply_committed_disconnect_failed"), "apply_committed_disconnect_failed"],
    [new LegacyImportJobRuntimeError("job_apply_committed_cleanup_failed"), "job_apply_committed_cleanup_failed"],
    [new LegacyImportJobRuntimeError("job_apply_committed_report_failed"), "job_apply_committed_report_failed"],
    [new Error("synthetic-secret-value"), "unexpected_import_failure"],
  ])("preserves safe outcome %s and fails once without retry", async (error, expected) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime.execute.mockRejectedValue(error);
    await legacyOperationsJobMain();
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith("ERROR: " + expected);
    expect(process.exitCode).toBe(1);
  });
});
