import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonFetcher } from "@/lib/fetcher";
import CustodianFeeScheduleDocuments from "./CustodianFeeScheduleDocuments";

const base = "/api/custodians/CUS-1/fee-schedules";
const saved = {
  id: "DOC-1",
  filename: "custodian-fees.pdf",
  contentType: "application/pdf",
  byteSize: 2048,
  createdAt: "2026-10-19T16:00:00Z",
  createdBy: "ops@example.test",
};

function renderDocuments({ canUpload = true, custodianId = "CUS-1", onUploaded = vi.fn() } = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), fetcher: jsonFetcher, dedupingInterval: 0, shouldRetryOnError: false }}>
      <CustodianFeeScheduleDocuments custodianId={custodianId} canUpload={canUpload} onUploaded={onUploaded} />
    </SWRConfig>,
  );
}

function selectFile(file = new File(["%PDF-1.7 synthetic original"], saved.filename, { type: "application/pdf" })) {
  fireEvent.change(screen.getByLabelText("Choose fee schedule"), { target: { files: [file] } });
  return file;
}

function posts() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [], nextCursor: null })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("custodian fee schedule originals", () => {
  it("shows an empty library and a separate selection step before any upload", async () => {
    renderDocuments();
    expect(await screen.findByText("No fee schedules attached yet.")).toBeInTheDocument();
    expect(screen.getByText("Keep the original schedule here for reference.")).toBeInTheDocument();
    const input = screen.getByLabelText("Choose fee schedule") as HTMLInputElement;
    expect(input.accept).toContain(".pdf,.png,.jpg,.jpeg");
    const openPicker = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Attach fee schedule" }));
    expect(openPicker).toHaveBeenCalledOnce();

    selectFile();
    expect(screen.getByText(saved.filename)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
    expect(posts()).toHaveLength(0);
  });

  it("uploads the selected original as multipart file data, refreshes the list, and reports completion", async () => {
    let uploaded = false;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        uploaded = true;
        return Response.json({ document: saved, duplicate: false }, { status: 201 });
      }
      return Response.json({ documents: uploaded ? [saved] : [], nextCursor: null });
    });
    const onUploaded = vi.fn();
    renderDocuments({ onUploaded });
    await screen.findByText("No fee schedules attached yet.");
    const file = selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Fee schedule attached.");
    expect(await screen.findByRole("link", { name: `Download ${saved.filename}` }))
      .toHaveAttribute("href", `${base}/${saved.id}`);
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0];
    expect(url).toBe(base);
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init!.body as FormData).get("file")).toBe(file);
    expect(Array.from((init!.body as FormData).keys())).toEqual(["file"]);
    expect(init?.headers).toBeUndefined();
    expect(onUploaded).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === base)).toBe(true);
  });

  it.each([
    ["spreadsheet.csv", "text/csv", "contents", "Choose a PDF, PNG, or JPEG file."],
    ["incorrect.pdf", "image/png", "contents", "Choose a PDF, PNG, or JPEG file."],
    ["empty.pdf", "application/pdf", "", "The selected file is empty."],
  ])("rejects invalid selection %s before any upload", async (name, type, contents, message) => {
    renderDocuments();
    await screen.findByText("No fee schedules attached yet.");
    selectFile(new File([contents], name, { type }));

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it.each(["", "application/octet-stream"])("allows an original with a valid extension and generic browser MIME %j", async (type) => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({ document: saved, duplicate: false }, { status: 201 })
      : Response.json({ documents: [], nextCursor: null }));
    renderDocuments();
    await screen.findByText("No fee schedules attached yet.");
    const file = selectFile(new File(["%PDF-1.7 synthetic original"], "original.pdf", { type }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Fee schedule attached.");
    expect(posts()).toHaveLength(1);
    expect((posts()[0][1]!.body as FormData).get("file")).toBe(file);
  });

  it("rejects files larger than 10 MB and accepts the exact limit", async () => {
    renderDocuments();
    await screen.findByText("No fee schedules attached yet.");
    const tooLarge = new File(["synthetic"], "large.png", { type: "image/png" });
    Object.defineProperty(tooLarge, "size", { value: 10 * 1024 * 1024 + 1 });
    selectFile(tooLarge);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a file no larger than 10 MB.");
    expect(posts()).toHaveLength(0);

    const maximum = new File(["synthetic"], "maximum.jpeg", { type: "image/jpeg" });
    Object.defineProperty(maximum, "size", { value: 10 * 1024 * 1024 });
    selectFile(maximum);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
  });

  it("cancels a reviewed selection without uploading and allows choosing it again", async () => {
    renderDocuments();
    await screen.findByText("No fee schedules attached yet.");
    const file = selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText(saved.filename)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    selectFile(file);
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
  });

  it("disables selection and repeat upload while a request is pending", async () => {
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return new Promise<Response>((resolve) => { complete = resolve; });
      return Response.json({ documents: [], nextCursor: null });
    });
    renderDocuments();
    await screen.findByText("No fee schedules attached yet.");
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(screen.getByRole("button", { name: "Uploading…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Attach fee schedule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Uploading…" }));
    expect(posts()).toHaveLength(1);
    await act(async () => { complete(Response.json({ document: saved, duplicate: false }, { status: 201 })); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Attach fee schedule" })).toBeEnabled());
  });

  it("preserves the server error and the selected file for retry", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({ error: "Original attachment storage is temporarily unavailable." }, { status: 503 })
      : Response.json({ documents: [], nextCursor: null }));
    const onUploaded = vi.fn();
    renderDocuments({ onUploaded });
    await screen.findByText("No fee schedules attached yet.");
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Original attachment storage is temporarily unavailable.");
    expect(screen.getByText(saved.filename)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a duplicate attachment without implying another copy was created", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({ document: saved, duplicate: true })
      : Response.json({ documents: [saved], nextCursor: null }));
    const onUploaded = vi.fn();
    renderDocuments({ onUploaded });
    await screen.findByRole("link", { name: `Download ${saved.filename}` });
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("status")).toHaveTextContent("This fee schedule is already attached.");
    await waitFor(() => expect(screen.getAllByRole("link", { name: `Download ${saved.filename}` })).toHaveLength(1));
    expect(onUploaded).toHaveBeenCalledOnce();
  });

  it("keeps successful upload feedback when only the subsequent list refresh fails", async () => {
    let uploaded = false;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        uploaded = true;
        return Response.json({ document: saved, duplicate: false }, { status: 201 });
      }
      return uploaded
        ? Response.json({ error: "Unavailable" }, { status: 503 })
        : Response.json({ documents: [], nextCursor: null });
    });
    const onUploaded = vi.fn();
    renderDocuments({ onUploaded });
    await screen.findByText("No fee schedules attached yet.");
    selectFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Fee schedule attached.");
    expect(await screen.findByRole("alert")).toHaveTextContent("The attachment was saved, but the list could not be refreshed. HTTP 503");
    expect(onUploaded).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(1);
  });

  it("paginates older documents and refreshes the newest page after an upload", async () => {
    let uploaded = false;
    const older = { ...saved, id: "DOC-OLD", filename: "older-schedule.pdf" };
    const newest = { ...saved, id: "DOC-NEW", filename: "new-schedule.pdf" };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        uploaded = true;
        return Response.json({ document: newest, duplicate: false }, { status: 201 });
      }
      return Response.json(String(url).includes("cursor=")
        ? { documents: [older], nextCursor: null }
        : { documents: uploaded ? [newest, saved] : [saved], nextCursor: "cursor/older" });
    });
    renderDocuments();
    fireEvent.click(await screen.findByRole("button", { name: "Older documents" }));
    expect(await screen.findByText(older.filename)).toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(`${base}?cursor=cursor%2Folder`, expect.any(Object));
    selectFile(new File(["%PDF-1.7"], newest.filename, { type: "application/pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByRole("link", { name: `Download ${newest.filename}` })).toBeInTheDocument();
    expect(screen.queryByText(older.filename)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Latest documents" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Older documents" }));
    await screen.findByText(older.filename);
    fireEvent.click(screen.getByRole("button", { name: "Latest documents" }));
    expect(await screen.findByRole("link", { name: `Download ${newest.filename}` })).toBeInTheDocument();
  });

  it("shows the stored filename, uploader, date, and size with a scoped authenticated download for viewers", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ documents: [{ ...saved, id: "DOC/1" }], nextCursor: null }));
    renderDocuments({ canUpload: false, custodianId: "CUS/1" });

    expect(await screen.findByRole("link", { name: `Download ${saved.filename}` }))
      .toHaveAttribute("href", "/api/custodians/CUS%2F1/fee-schedules/DOC%2F1");
    expect(screen.getByText(/ops@example.test/)).toHaveTextContent(new Date(saved.createdAt).toLocaleString("en-US"));
    expect(screen.getByText(/ops@example.test/)).toHaveTextContent("2.0 KB");
    expect(screen.queryByRole("button", { name: "Attach fee schedule" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose fee schedule")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("shows retrieval failures without an empty-state claim and allows refresh", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 500 }));
    renderDocuments({ canUpload: false });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load fee schedules.");
    expect(screen.queryByText("No fee schedules attached yet.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh fee schedules" }));
    expect(await screen.findByText("No fee schedules attached yet.")).toBeInTheDocument();
  });
});
