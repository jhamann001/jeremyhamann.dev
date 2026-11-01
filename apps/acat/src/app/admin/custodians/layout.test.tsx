import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { markCase } from "@/lib/test-flywheel";

vi.mock("@/lib/prisma", () => import("@/lib/__mocks__/prisma"));
vi.mock("@/lib/machine-auth", () => ({ verifyCustodianAdminCaller: vi.fn() }));
vi.mock("@/lib/rate-limit-redis", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/custodian-timing-data", () => ({
  loadObservedCustodianTimings: vi.fn().mockResolvedValue(new Map()),
}));

import CustodiansAdminLayout from "./layout";

const SWITCH = "ENFORCE_CUSTODIAN_TRACKER_READ_ONLY";

afterEach(() => vi.unstubAllEnvs());

describe("custodian administrator screens", () => {
  it("retirement switch on shows the retired screen and does not mount the editor", () => {
    vi.stubEnv(SWITCH, "1");
    render(
      <CustodiansAdminLayout>
        <p>editor mounted</p>
      </CustodiansAdminLayout>,
    );
    expect(screen.getByText("Custodian editing has been retired.")).toBeTruthy();
    expect(screen.queryByText("editor mounted")).toBeNull();
    markCase(
      "custodian-edit-retirement",
      "retirement switch on shows the retired screen and does not mount the editor",
    );
  });

  it("retirement switch off mounts the current editor", () => {
    vi.stubEnv(SWITCH, "0");
    render(
      <CustodiansAdminLayout>
        <p>editor mounted</p>
      </CustodiansAdminLayout>,
    );
    expect(screen.getByText("editor mounted")).toBeTruthy();
    markCase("custodian-edit-retirement", "retirement switch off mounts the current editor");
  });
});
