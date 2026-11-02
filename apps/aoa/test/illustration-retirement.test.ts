import { beforeEach, describe, expect, it, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({ permanentRedirect: vi.fn() }));
vi.mock("next/navigation", () => ({ permanentRedirect }));

import Page from "@/app/(authenticated)/client-portrait/[id]/illustration/page";

describe("retired Illustration URLs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("permanently sends old links to Portrait without loading the old experience", async () => {
    await Page({ params: Promise.resolve({ id: "SYNTHETIC" }), searchParams: Promise.resolve({}) });
    expect(permanentRedirect).toHaveBeenCalledExactlyOnceWith("/client-portrait/SYNTHETIC?portraitTab=comms");
  });

  it("keeps directory metadata and repeated query values while discarding stale pane selection", async () => {
    await Page({
      params: Promise.resolve({ id: "SYNTHETIC" }),
      searchParams: Promise.resolve({
        portraitTab: "financial", q: "Sample & Family", filter: ["active", "assigned"], absent: undefined,
      }),
    });
    expect(permanentRedirect).toHaveBeenCalledExactlyOnceWith(
      "/client-portrait/SYNTHETIC?q=Sample+%26+Family&filter=active&filter=assigned&portraitTab=comms",
    );
  });

  it("always constructs an internal client route from the encoded identifier", async () => {
    await Page({
      params: Promise.resolve({ id: "//outside.invalid/path?x=y" }),
      searchParams: Promise.resolve({ returnTo: "https://outside.invalid", portraitTab: ["financial", "portrait"] }),
    });
    expect(permanentRedirect).toHaveBeenCalledExactlyOnceWith(
      "/client-portrait/%2F%2Foutside.invalid%2Fpath%3Fx%3Dy?returnTo=https%3A%2F%2Foutside.invalid&portraitTab=comms",
    );
  });
});
