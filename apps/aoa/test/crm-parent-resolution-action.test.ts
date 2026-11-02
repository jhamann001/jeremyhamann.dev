import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, confirmSpy, revalidateSpy, redirectSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), confirmSpy: vi.fn(), revalidateSpy: vi.fn(), redirectSpy: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/data/crm-parent-resolution", () => ({ confirmCrmParentOverride: confirmSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: redirectSpy }));

import { confirmCrmParentMapping } from "@/app/(authenticated)/crm/[id]/actions";

function form() {
  const data = new FormData();
  data.set("exceptionId", "c_exception");
  data.set("childCrmId", "apt_child");
  data.set("parentCrmId", "con_parent");
  return data;
}

describe("inline CRM parent confirmation action", () => {
  beforeEach(() => {
    authSpy.mockReset().mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.com" } });
    confirmSpy.mockReset().mockResolvedValue("saved");
    revalidateSpy.mockReset();
    redirectSpy.mockReset();
  });

  it("saves as the signed-in operator, refreshes counts, and returns to the CRM record", async () => {
    await confirmCrmParentMapping(form());
    expect(confirmSpy).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.com" },
      { exceptionId: "c_exception", childCrmId: "apt_child", parentCrmId: "con_parent" },
    );
    expect(revalidateSpy).toHaveBeenCalledWith("/crm");
    expect(revalidateSpy).toHaveBeenCalledWith("/review-queue");
    expect(revalidateSpy).toHaveBeenCalledWith("/", "layout");
    expect(redirectSpy).toHaveBeenCalledWith(
      "/crm/apt_child?resolutionException=c_exception&resolutionMessage=saved#resolve-parent-mapping",
    );
  });

  it("returns a safe generic failure without exposing database detail", async () => {
    confirmSpy.mockResolvedValueOnce("invalid");
    await confirmCrmParentMapping(form());
    expect(redirectSpy).toHaveBeenCalledWith(
      "/crm/apt_child?resolutionException=c_exception&resolutionMessage=failed#resolve-parent-mapping",
    );
  });
});
