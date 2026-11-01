import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { mockUseSWR, mockMutate, mockFetch, effectiveRole } = vi.hoisted(() => ({
  mockUseSWR: vi.fn(),
  mockMutate: vi.fn(),
  mockFetch: vi.fn(),
  effectiveRole: { current: "USER" },
}));

vi.mock("swr", () => ({
  default: (...args: unknown[]) => mockUseSWR(...args),
  useSWRConfig: () => ({ mutate: mockMutate }),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { email: "ops@example.com", role: effectiveRole.current } },
    status: "authenticated",
  }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/use-effective-role", () => ({
  useEffectiveRole: () => ({ role: effectiveRole.current }),
}));

const { default: CustodianDetailPage } = await import("./page");

const baseFee = {
  id: "fee1",
  feeType: "Transfer fee",
  accountType: "ANY",
  transferType: "FULL",
  direction: "ANY",
  amount: 50,
  amountText: null,
  notes: null,
  documentation: null,
  updatedAt: "2026-10-19T12:00:00.000Z",
};

// Minimal CustodianDetail shape used by PlaybookPanel's display branch.
const baseData = {
  id: "c1",
  name: "Ameriprise Financial Services",
  avgProcessingDays: 7,
  contactEmail: null as string | null,
  contactMethod: null as string | null,
  contactDetails: null as string | null,
  reviewStatus: "VERIFIED",
  transferType: "ACAT_API",
  documentationStatus: "DOCUMENTED",
  dtcNumber: "0756",
  receivingAccountNumber: null as string | null,
  signature: null as string | null,
  letterOfAcceptance: null as string | null,
  medallionRequired: null as string | null,
  liquidationMethod: null as string | null,
  returnMethod: null as string | null,
  watchouts: "First watchout\nSecond watchout",
  paperworkOnFile: true,
  transfersToDate: 1,
  recentClients: "Ellis",
  linkedRecordCount: 2,
  feeScheduleDocumentCount: 0,
  fees: [] as Array<typeof baseFee>,
};

function renderDisplay(overrides: Partial<typeof baseData> = {}) {
  const detail = { ...baseData, ...overrides };
  mockUseSWR.mockImplementation((key: string) => ({
    data: key === "/api/custodians/c1" ? detail : [],
    error: null,
    isLoading: false,
    mutate: mockMutate,
  }));
  return render(<CustodianDetailPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  effectiveRole.current = "USER";
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function playbookButton(name: "Edit" | "Save" | "Cancel") {
  const header = screen.getByRole("heading", { name: "Transfer playbook" }).parentElement!;
  return within(header).getByRole("button", { name });
}

function renderEditor(overrides: Partial<typeof baseData> = {}) {
  effectiveRole.current = "ADMIN";
  const result = renderDisplay(overrides);
  fireEvent.click(playbookButton("Edit"));
  return result;
}

function choose(label: string, value: string) {
  fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
}

async function saveAndReadPayload() {
  fireEvent.click(playbookButton("Save"));
  await waitFor(() => expect(mockMutate).toHaveBeenCalledOnce());
  expect(mockFetch).toHaveBeenCalledOnce();
  expect(mockFetch).toHaveBeenCalledWith(
    "/api/custodians/c1",
    expect.objectContaining({ method: "PATCH" }),
  );
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

describe("ticket — PlaybookPanel display restyle", () => {
  it("offers merge instead of delete when a fee schedule is attached without transfers", () => {
    effectiveRole.current = "ADMIN";
    renderDisplay({ linkedRecordCount: 0, feeScheduleDocumentCount: 1 });
    expect(screen.queryByRole("button", { name: "Delete custodian" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach fee schedule" })).toBeInTheDocument();
  });

  it("renders exactly the four grouped sub-panels plus a Watchouts panel", () => {
    const { container } = renderDisplay();
    // Routing / Requirements / Proceeds & contact / Track record + Watchouts.
    expect(container.querySelectorAll("[data-playbook-group]").length).toBe(5);
  });

  it("renders categorical values as pills (DTC, transfer type, doc status, paperwork, transfers)", () => {
    const { container } = renderDisplay();
    // baseData has all five categorical fields populated → five pills.
    expect(container.querySelectorAll("[data-pill]").length).toBe(5);
  });

  it("renders watchouts as bulleted list items, one per line", () => {
    const { getAllByRole } = renderDisplay();
    expect(getAllByRole("listitem").length).toBe(2);
  });

  it("labels a receiving house account as a last-known value to verify", () => {
    const { getByText } = renderDisplay({
      name: "Victory Funds",
      receivingAccountNumber: "DEMOOMNI01",
    });

    expect(getByText("DEMOOMNI01")).toBeInTheDocument();
    expect(getByText("Verify before use")).toBeInTheDocument();
  });
});

describe("Transfer playbook dropdowns", () => {
  const legacyChoices = {
    signature: "  Wet signature unless pre-approved  ",
    letterOfAcceptance: "Depends on registration / ask transfer team",
    medallionRequired: "Only above custodian threshold",
    liquidationMethod: "Call before liquidating mutual funds",
    returnMethod: "Send to transfer team with reference number",
  };
  const choiceLabels = [
    ["signature", "Signature"],
    ["letterOfAcceptance", "Letter of acceptance"],
    ["medallionRequired", "Medallion (MSG)"],
    ["liquidationMethod", "Liquidation proceeds"],
    ["returnMethod", "Return method"],
  ] as const;

  it("offers labeled dropdowns and saves standard choices for all five playbook fields", async () => {
    renderEditor();

    choose("Signature", "Wet only");
    choose("Letter of acceptance", "Required");
    choose("Medallion (MSG)", "Not required");
    choose("Liquidation proceeds", "Wire");
    choose("Return method", "Portal");

    expect(await saveAndReadPayload()).toEqual({
      signature: "Wet only",
      letterOfAcceptance: "Required",
      medallionRequired: "Not required",
      liquidationMethod: "Wire",
      returnMethod: "Portal",
    });
  });

  it("keeps unset distinct from unknown or an exception requiring Watchouts", () => {
    renderEditor();

    for (const [, label] of choiceLabels) {
      const select = screen.getByRole("combobox", { name: label });
      expect(select).toHaveValue("");
      expect(within(select).getByRole("option", { name: /^Unknown/ })).toHaveValue("Unknown");
      expect(within(select).getByRole("option", { name: "Other — see Watchouts" }))
        .toHaveValue("Other — see Watchouts");
    }
    expect(screen.getByRole("combobox", { name: "Contact method" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Contact details" })).not.toBeInTheDocument();

    fireEvent.click(playbookButton("Save"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("preserves exact legacy values and saves nothing when the editor is unchanged", () => {
    renderEditor(legacyChoices);

    for (const [key, label] of choiceLabels) {
      const select = screen.getByRole("combobox", { name: label }) as HTMLSelectElement;
      expect(select).toHaveValue(legacyChoices[key]);
      expect(select.selectedOptions[0].textContent).toBe(`Existing: ${legacyChoices[key]}`);
    }

    fireEvent.click(playbookButton("Save"));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(playbookButton("Edit")).toBeInTheDocument();
  });

  it("does not overwrite or trim legacy choices when an unrelated field changes", async () => {
    renderEditor(legacyChoices);
    fireEvent.change(screen.getByRole("textbox", { name: "DTC / clearing #" }), {
      target: { value: "0731" },
    });

    expect(await saveAndReadPayload()).toEqual({ dtcNumber: "0731" });
  });

  it("can replace one legacy choice while preserving every other one", async () => {
    renderEditor(legacyChoices);
    choose("Signature", "DocuSign OK");

    expect(await saveAndReadPayload()).toEqual({ signature: "DocuSign OK" });
  });

  it("keeps the original legacy choice available to undo a selection before saving", () => {
    renderEditor(legacyChoices);
    choose("Signature", "DocuSign OK");
    choose("Signature", legacyChoices.signature);

    expect(screen.getByRole("combobox", { name: "Signature" })).toHaveValue(legacyChoices.signature);
    fireEvent.click(playbookButton("Save"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("cancels choice and contact edits without saving, and restores stored values on reopening", () => {
    renderEditor({
      ...legacyChoices,
      contactMethod: "PHONE",
      contactDetails: "800-555-0100 ext 3",
    });
    choose("Signature", "Not required");
    choose("Contact method", "PORTAL");
    fireEvent.change(screen.getByRole("textbox", { name: "Contact details" }), {
      target: { value: "https://portal.example.test" },
    });
    fireEvent.click(playbookButton("Cancel"));

    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.click(playbookButton("Edit"));
    expect(screen.getByRole("combobox", { name: "Signature" })).toHaveValue(legacyChoices.signature);
    expect(screen.getByRole("combobox", { name: "Contact method" })).toHaveValue("PHONE");
    expect(screen.getByRole("textbox", { name: "Contact details" })).toHaveValue("800-555-0100 ext 3");
  });

  it("sends null when existing playbook choices are explicitly cleared", async () => {
    renderEditor(legacyChoices);
    for (const [, label] of choiceLabels) choose(label, "");

    expect(await saveAndReadPayload()).toEqual({
      signature: null,
      letterOfAcceptance: null,
      medallionRequired: null,
      liquidationMethod: null,
      returnMethod: null,
    });
  });

  it("opens legacy email as Email plus details without rewriting it on an unchanged save", () => {
    renderEditor({ contactEmail: "transfers@example.test" });

    expect(screen.getByRole("combobox", { name: "Contact method" })).toHaveValue("EMAIL");
    expect(screen.getByRole("textbox", { name: "Contact details" })).toHaveValue("transfers@example.test");
    fireEvent.click(playbookButton("Save"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("leaves legacy email untouched when saving another playbook field", async () => {
    renderEditor({ contactEmail: "transfers@example.test" });
    choose("Signature", "DocuSign OK");

    expect(await saveAndReadPayload()).toEqual({ signature: "DocuSign OK" });
  });

  it.each([
    ["EMAIL", "new-transfers@example.test"],
    ["PHONE", "800-555-0100 ext 3"],
    ["PORTAL", "https://portal.example.test/transfers"],
    ["OTHER", "Ask the transfer team for the current contact"],
  ])("saves the %s contact method together with its details", async (method, details) => {
    renderEditor({ contactEmail: "old-transfers@example.test" });
    choose("Contact method", method);
    fireEvent.change(screen.getByRole("textbox", { name: "Contact details" }), {
      target: { value: details },
    });

    expect(await saveAndReadPayload()).toEqual({ contactMethod: method, contactDetails: details });
  });

  it("sends both contact fields when only existing contact details change", async () => {
    renderEditor({ contactMethod: "PHONE", contactDetails: "800-555-0100" });
    fireEvent.change(screen.getByRole("textbox", { name: "Contact details" }), {
      target: { value: "800-555-0100 ext 4" },
    });

    expect(await saveAndReadPayload()).toEqual({
      contactMethod: "PHONE",
      contactDetails: "800-555-0100 ext 4",
    });
  });

  it("restores the original contact details after switching methods and back without a save", () => {
    renderEditor({ contactMethod: "EMAIL", contactDetails: "transfers@example.test" });
    choose("Contact method", "PHONE");
    expect(screen.getByRole("textbox", { name: "Contact details" })).toHaveValue("");
    choose("Contact method", "EMAIL");

    expect(screen.getByRole("textbox", { name: "Contact details" })).toHaveValue("transfers@example.test");
    fireEvent.click(playbookButton("Save"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps unsaved contact edits when switching methods and back", async () => {
    renderEditor({ contactEmail: "transfers@example.test" });
    fireEvent.change(screen.getByRole("textbox", { name: "Contact details" }), {
      target: { value: "updated-transfers@example.test" },
    });
    choose("Contact method", "PHONE");
    choose("Contact method", "EMAIL");

    expect(screen.getByRole("textbox", { name: "Contact details" })).toHaveValue("updated-transfers@example.test");
    expect(await saveAndReadPayload()).toEqual({
      contactMethod: "EMAIL",
      contactDetails: "updated-transfers@example.test",
    });
  });

  it.each([
    { contactEmail: "transfers@example.test" },
    { contactMethod: "PHONE", contactDetails: "800-555-0100" },
  ])("clears both contact fields when the contact method is cleared: %j", async (contact) => {
    renderEditor(contact);
    choose("Contact method", "");

    expect(screen.queryByRole("textbox", { name: "Contact details" })).not.toBeInTheDocument();
    expect(await saveAndReadPayload()).toEqual({ contactMethod: null, contactDetails: null });
  });

  it("keeps playbook editing unavailable to non-admin users", () => {
    renderDisplay({ signature: "Wet only", contactMethod: "PHONE", contactDetails: "800-555-0100" });

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("Custodian fee direction relative to Apex", () => {
  it.each([
    ["Transfer into Apex", "OUT"],
    ["Transfer out of Apex", "IN"],
    ["Both directions", "ANY"],
  ])("saves %s using the existing contra direction %s", async (label, direction) => {
    effectiveRole.current = "ADMIN";
    renderDisplay();
    fireEvent.click(screen.getByRole("button", { name: "Add fee" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Fee type" }), {
      target: { value: "Transfer fee" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Amount (USD, blank if unknown)" }), {
      target: { value: "50" },
    });

    const select = screen.getByRole("combobox", { name: "Transfer direction relative to Apex" });
    const option = within(select).getByRole("option", { name: label }) as HTMLOptionElement;
    expect(option.value).toBe(direction);
    fireEvent.change(select, { target: { value: option.value } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledOnce());
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/custodians/c1/fees",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      feeType: "Transfer fee",
      amount: 50,
      direction,
    });
  });

  it("displays fee direction badges from Apex's perspective", () => {
    renderDisplay({
      fees: [
        { ...baseFee, id: "fee-out", direction: "OUT" },
        { ...baseFee, id: "fee-in", direction: "IN" },
        { ...baseFee, id: "fee-any", direction: "ANY" },
      ],
    });

    expect(screen.getByText("Transfer into Apex")).toBeInTheDocument();
    expect(screen.getByText("Transfer out of Apex")).toBeInTheDocument();
    expect(screen.getByText("Both directions")).toBeInTheDocument();
    expect(screen.queryByText(/^Dir:/)).not.toBeInTheDocument();
  });
});
