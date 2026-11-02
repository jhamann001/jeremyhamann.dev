import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(), edits: vi.fn(), linking: vi.fn(), destinations: vi.fn(), documents: vi.fn(), onDemand: vi.fn(), workspace: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({
  assetMappingReadEnabled: m.enabled,
  assetMappingEditsEnabled: m.edits,
  assetMappingClientLinkingEnabled: m.linking,
  assetMappingDestinationsEnabled: m.destinations,
  assetMappingDocumentsEnabled: m.documents,
  assetMappingOnDemandImportEnabled: m.onDemand,
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: () => { throw new Error("REDIRECT"); },
}));
vi.mock("@/components/asset-mapping/workspace/AssetMappingWorkspace", () => ({
  AssetMappingWorkspace: (props: { initialRunId: string | null }) => {
    m.workspace(props);
    return createElement("div", { "data-testid": "asset-mapping-workspace" });
  },
}));

import Page from "@/app/(authenticated)/asset-mapping/page";

async function html(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
}

function signIn(role: string) {
  m.auth.mockResolvedValue({ user: { role, email: `${role.toLowerCase()}@example.invalid` } });
}

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
  m.edits.mockReturnValue(false);
  m.linking.mockReturnValue(false);
  m.destinations.mockReturnValue(false);
  m.documents.mockReturnValue(false);
  m.onDemand.mockReturnValue(false);
  signIn("OPERATIONS");
});

describe("/asset-mapping page gate", () => {
  it("flag off returns not found for OPERATIONS", async () => {
    m.enabled.mockReturnValue(false);
    await expect(html()).rejects.toThrow("NOT_FOUND");
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("renders %s read-only, with every write slice off even when its flag is on (ticket)", async (role) => {
    signIn(role);
    m.edits.mockReturnValue(true);
    m.linking.mockReturnValue(true);
    m.destinations.mockReturnValue(true);
    m.documents.mockReturnValue(true);
    m.onDemand.mockReturnValue(true);
    const output = await html({ run: "synthetic-run-1" });
    expect(output).toContain('data-testid="asset-mapping-workspace"');
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: "synthetic-run-1", canOperate: false, canEdit: false, canLink: true, canEditDestinations: false, documents: { enabled: true, canOperate: false }, onDemandImport: false });
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("flag off returns not found for %s", async (role) => {
    signIn(role);
    m.enabled.mockReturnValue(false);
    await expect(html()).rejects.toThrow("NOT_FOUND");
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it("returns not found for an unknown role", async () => {
    signIn("HEAD_OF_SOMETHING");
    await expect(html()).rejects.toThrow("NOT_FOUND");
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it("flag on returns not found for VIEWER", async () => {
    signIn("VIEWER");
    await expect(html()).rejects.toThrow("NOT_FOUND");
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it("signed out redirects to sign-in", async () => {
    m.auth.mockResolvedValue(null);
    await expect(html()).rejects.toThrow("REDIRECT");
    expect(m.workspace).not.toHaveBeenCalled();
  });

  it("renders the workspace for OPERATIONS with the run param when the flag is on", async () => {
    const output = await html({ run: "synthetic-run-1" });
    expect(output).toContain('data-testid="asset-mapping-workspace"');
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: "synthetic-run-1", canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("renders the workspace for ADMIN when the flag is on", async () => {
    signIn("ADMIN");
    const output = await html();
    expect(output).toContain('data-testid="asset-mapping-workspace"');
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes canEdit true when the edits flag is on", async () => {
    m.edits.mockReturnValue(true);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: true, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes canEdit false when the edits flag is off", async () => {
    signIn("ADMIN");
    m.edits.mockReturnValue(false);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes canLink true when the client-linking flag is on", async () => {
    m.linking.mockReturnValue(true);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: true, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes canLink false when the client-linking flag is off", async () => {
    signIn("ADMIN");
    m.linking.mockReturnValue(false);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes canEditDestinations true when the destinations flag is on", async () => {
    m.destinations.mockReturnValue(true);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: true, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes canEditDestinations false when the destinations flag is off", async () => {
    signIn("ADMIN");
    m.destinations.mockReturnValue(false);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it("passes documents enabled from the documents flag", async () => {
    m.documents.mockReturnValue(true);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: true, canOperate: true }, onDemandImport: false });
  });

  it("passes documents disabled when the documents flag is off", async () => {
    signIn("ADMIN");
    m.documents.mockReturnValue(false);
    await html();
    expect(m.workspace).toHaveBeenCalledWith({ initialRunId: null, canOperate: true, canEdit: false, canLink: false, canEditDestinations: false, documents: { enabled: false, canOperate: true }, onDemandImport: false });
  });

  it.each([true, false])("passes onDemandImport %s from the on-demand import flag (ticket)", async (on) => {
    m.onDemand.mockReturnValue(on);
    await html();
    expect(m.workspace).toHaveBeenCalledWith(expect.objectContaining({ onDemandImport: on }));
  });
});
