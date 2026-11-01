import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClientIdentityStatus } from "@/hooks/use-client-identity-status";
import { mockAcats } from "@/lib/mock-data";
import type { ClientDirectoryStatus } from "@/lib/client-identity-contract";
import ClientIdentityRelinkDialog from "./ClientIdentityRelinkDialog";

vi.mock("@/hooks/use-client-identity-status", () => ({ useClientIdentityStatus: vi.fn() }));
const status: ClientDirectoryStatus = { enabled: true, health: "FRESH", writeEligible: true, pendingAccountPolicy: "PENDING_ACCOUNT_OPENING_ONLY", lastSuccessAt: "2026-09-25T12:00:00Z", sourceAsOf: "2026-09-25T12:00:00Z" };
const record = { ...mockAcats[0], id: "synthetic-record", clientName: "Historical Alex Example", cedarRidgeUserId: "user-synthetic-11111111", identityVersion: 4, apexAccountId: "001234", mappingAccountId: "synthetic-mapping" };

beforeEach(() => {
  vi.mocked(useClientIdentityStatus).mockReturnValue({ status, loading: false, error: null, refresh: vi.fn() });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => record }));
});
afterEach(() => vi.unstubAllGlobals());

describe("ClientIdentityRelinkDialog", () => {
  it("preserves historical name and account by default and requires an audit reason", async () => {
    const onSaved = vi.fn(); const onClose = vi.fn();
    render(<ClientIdentityRelinkDialog acat={record} onSaved={onSaved} onClose={onClose} />);
    const save = screen.getByRole("button", { name: "Save client link" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Verified the source account owner" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(`/api/acats/${record.id}/client-identity`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ cedarRidgeUserIds: [record.cedarRidgeUserId], expectedIdentityVersion: 4, reason: "Verified the source account owner" }) }));
  });

  it("allows a fresh verified relink when creation cutover is disabled", async () => {
    vi.mocked(useClientIdentityStatus).mockReturnValue({ status: { ...status, enabled: false, writeEligible: false }, loading: false, error: null, refresh: vi.fn() });
    const onSaved = vi.fn();
    render(<ClientIdentityRelinkDialog acat={record} onSaved={onSaved} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Verified existing client during staged rollout" } });
    expect(screen.queryByText(/Linking is paused/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save client link" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it.each([
    { health: "STALE" as const, loading: false, error: null },
    { health: "UNAVAILABLE" as const, loading: false, error: null },
    { health: "FRESH" as const, loading: true, error: null },
    { health: "FRESH" as const, loading: false, error: "Client directory status is unavailable. Try again." },
  ])("blocks relink with cutover disabled and health=$health loading=$loading error=$error", ({ health, loading, error }) => {
    vi.mocked(useClientIdentityStatus).mockReturnValue({ status: { ...status, enabled: false, health, writeEligible: false }, loading, error, refresh: vi.fn() });
    render(<ClientIdentityRelinkDialog acat={record} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Verify before correcting" } });
    expect(screen.getByRole("button", { name: "Save client link" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes name replacement and its mapping consequence explicit", async () => {
    render(<ClientIdentityRelinkDialog acat={record} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Correct the account and directory name" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Apex Account #" }), { target: { value: "005678" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Replace the historical display name with the directory name" }));
    const save = screen.getByRole("button", { name: "Save client link" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /clears the saved statement-account mapping link/ }));
    fireEvent.click(save);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ apexAccountId: "005678", replaceDisplayName: true, acknowledgeMappingInvalidation: true });
    expect(body).not.toHaveProperty("clientName");
  });

  it("retains the reviewed version when a background refresh arrives", async () => {
    const props = { onSaved: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<ClientIdentityRelinkDialog acat={record} {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Verified ownership" } });
    rerender(<ClientIdentityRelinkDialog acat={{ ...record, identityVersion: 5 }} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save client link" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).expectedIdentityVersion).toBe(4);
  });

  it("stops retrying a conflicting identity until the record is reviewed again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: "IDENTITY_CONFLICT", error: "Changed" }) }));
    const onSaved = vi.fn(); const onClose = vi.fn();
    render(<ClientIdentityRelinkDialog acat={record} onSaved={onSaved} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Verified ownership" } });
    fireEvent.click(screen.getByRole("button", { name: "Save client link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Close and reopen");
    expect(screen.getByRole("button", { name: "Save client link" })).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close and refresh record" }));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("initializes every linked person, preserves the historical name, and removes only an explicitly removed person", async () => {
    const linkedClients = [{ cedarRidgeUserId: record.cedarRidgeUserId, displayName: "Alex Example" }, { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Jordan Example" }];
    render(<ClientIdentityRelinkDialog acat={{ ...record, cedarRidgeUserId: null, cedarRidgeUserIds: linkedClients.map((client) => client.cedarRidgeUserId), linkedClients }} onSaved={vi.fn()} onClose={vi.fn()} />);
    const selected = screen.getByRole("list", { name: "Selected clients" });
    expect(within(selected).getByText("Alex Example")).toBeInTheDocument();
    expect(within(selected).getByText("Jordan Example")).toBeInTheDocument();
    expect(screen.getByText("Historical Alex Example")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Remove Alex Example/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Reviewed the correct joint holder" } });
    fireEvent.click(screen.getByRole("button", { name: "Save client link" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ cedarRidgeUserIds: [linkedClients[1].cedarRidgeUserId], expectedIdentityVersion: 4, reason: "Reviewed the correct joint holder" });
  });

  it("blocks a blank pending account with multiple people but permits it after explicitly removing one", () => {
    const linkedClients = [{ cedarRidgeUserId: record.cedarRidgeUserId, displayName: "Alex Example" }, { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Jordan Example" }];
    render(<ClientIdentityRelinkDialog acat={{ ...record, status: "PendingAccountOpening", apexAccountId: "", cedarRidgeUserId: null, cedarRidgeUserIds: linkedClients.map((client) => client.cedarRidgeUserId), linkedClients }} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Reviewed pending account" } });
    expect(screen.getByRole("button", { name: "Save client link" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Remove Jordan Example/ }));
    expect(screen.getByRole("button", { name: "Save client link" })).toBeEnabled();
  });

  it("keeps both selected people when the server rejects their joint membership", async () => {
    const linkedClients = [{ cedarRidgeUserId: record.cedarRidgeUserId, displayName: "Alex Example" }, { cedarRidgeUserId: "user-synthetic-22222222", displayName: "Jordan Example" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ code: "ACCOUNT_NOT_LINKED", error: "All selected people must be joint holders of this account." }) }));
    render(<ClientIdentityRelinkDialog acat={{ ...record, cedarRidgeUserId: null, cedarRidgeUserIds: linkedClients.map((client) => client.cedarRidgeUserId), linkedClients }} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Confirm joint ownership" } });
    fireEvent.click(screen.getByRole("button", { name: "Save client link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must be joint holders");
    expect(within(screen.getByRole("list", { name: "Selected clients" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("blocks writes against an unavailable directory or missing version", () => {
    vi.mocked(useClientIdentityStatus).mockReturnValue({ status: { ...status, health: "STALE", writeEligible: false }, loading: false, error: null, refresh: vi.fn() });
    render(<ClientIdentityRelinkDialog acat={{ ...record, identityVersion: undefined }} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Reason for this change" }), { target: { value: "Verified ownership" } });
    expect(screen.getByRole("button", { name: "Save client link" })).toBeDisabled();
    expect(screen.getByText(/fresh verified update/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh this record");
    expect(fetch).not.toHaveBeenCalled();
  });
});
