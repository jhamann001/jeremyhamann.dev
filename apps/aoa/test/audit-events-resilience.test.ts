import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const { auth, read, refresh } = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), refresh: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/data/audit-log", () => ({ listAuditLog: read }));
vi.mock("@/lib/data/row-changes", () => ({ listRowChangeWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ refresh }) }));
vi.mock("@/components/audit/AuditDirectory", () => ({ AuditDirectory: () => "Synthetic events" }));
vi.mock("@/components/audit/AuditFieldChangesDirectory", () => ({ AuditFieldChangesDirectory: () => null, AuditFieldChangesUnavailable: () => null }));
vi.mock("@/components/navigation/RememberedListLink", () => ({ RememberedListLink: ({ children }: { children: string }) => children }));
import Page from "@/app/(authenticated)/audit-log/page";

describe("Audit Events first-read resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.invalid" }, navigationScope: "synthetic-scope" });
  });
  it("renders an explicit unavailable state without server details, empty results or automatic retry", async () => {
    read.mockRejectedValue(new Error("SELECT private_row secret@example.invalid"));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ action: "pn.navigation" }) }));
    expect(html).toContain("Audit events could not be loaded. No data was changed.");
    expect(html).toContain("Retry audit events");
    expect(html).toContain("Field changes");
    expect(html).not.toMatch(/private_row|secret@example|No events|0 events/);
    expect(read).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("does not catch authentication failure or convert forbidden results into retry", async () => {
    auth.mockRejectedValueOnce(new Error("auth unavailable"));
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow("auth unavailable");
    expect(read).not.toHaveBeenCalled();
    auth.mockResolvedValueOnce(null);
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/");
    read.mockResolvedValueOnce({ ok: false, reason: "forbidden" });
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Access denied"); expect(html).not.toContain("Retry audit events");
  });
  it("keeps a successful page and out-of-range redirects outside the catch", async () => {
    const result = { ok: true, page: 1, pageCount: 2, snapshot: "synthetic", actions: [], actors: [], rows: [] };
    read.mockResolvedValueOnce(result);
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }))).toContain("Synthetic events");
    read.mockResolvedValueOnce({ ...result, page: 3 });
    await expect(Page({ searchParams: Promise.resolve({ action: "pn.navigation", page: "3" }) }))
      .rejects.toThrow("redirect:/audit-log?action=pn.navigation&page=2");
  });
});
