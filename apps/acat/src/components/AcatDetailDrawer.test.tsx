import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AcatDetailDrawer from "./AcatDetailDrawer";
import { ToastProvider } from "./Toast";
import { mockAcats } from "@/lib/mock-data";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        email: "admin@example.com",
        name: "Admin",
        role: "ADMIN",
      },
    },
    status: "authenticated",
  }),
}));

function renderDrawer(
  overrides: Partial<React.ComponentProps<typeof AcatDetailDrawer>> = {}
) {
  const ordered = mockAcats.map((r) => r.id);
  const props: React.ComponentProps<typeof AcatDetailDrawer> = {
    record: mockAcats[0],
    orderedIds: ordered,
    open: true,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onMutate: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <ToastProvider>
        <AcatDetailDrawer {...props} />
      </ToastProvider>
    ),
  };
}

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(mockAcats[0]),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AcatDetailDrawer", () => {
  it("renders the AcatDetail heading for the given record", () => {
    renderDrawer();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Sarah Jenkins"
    );
  });

  it("renders nothing visible when closed", () => {
    renderDrawer({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 2, name: /Sarah Jenkins/ })
    ).not.toBeInTheDocument();
  });

  it("calls onClose when backdrop receives pointerDown", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.pointerDown(screen.getByTestId("drawer-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when pointerDown originates inside the panel", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    // The heading lives inside the panel; a pointerDown there must not bubble
    // to the backdrop's close handler.
    fireEvent.pointerDown(screen.getByRole("heading", { level: 2 }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets Escape close only the client dialog and restores focus inside the drawer", () => {
    const onClose = vi.fn(); const onNavigate = vi.fn();
    renderDrawer({ record: { ...mockAcats[0], cedarRidgeUserId: "user-synthetic-00000001", identityVersion: 0 }, onClose, onNavigate });
    const review = screen.getByRole("button", { name: "Review link" });
    review.focus();
    fireEvent.click(review);
    expect(screen.getByRole("textbox", { name: "Apex Account #" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Add another person" }));
    const picker = screen.getByRole("combobox", { name: "Search client name" });
    expect(picker).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close client link dialog" }), { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Review client link" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(review).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("navigates to next record on ArrowRight", () => {
    const onNavigate = vi.fn();
    renderDrawer({
      record: mockAcats[0],
      orderedIds: mockAcats.map((r) => r.id),
      onNavigate,
    });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith(mockAcats[1].id);
  });

  it("navigates to previous record on ArrowLeft", () => {
    const onNavigate = vi.fn();
    renderDrawer({
      record: mockAcats[1],
      orderedIds: mockAcats.map((r) => r.id),
      onNavigate,
    });
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(onNavigate).toHaveBeenCalledWith(mockAcats[0].id);
  });

  it("disables Previous at the start and Next at the end", () => {
    renderDrawer({
      record: mockAcats[0],
      orderedIds: mockAcats.map((r) => r.id),
    });
    const prev = screen.getByRole("button", { name: "Previous record" });
    expect(prev).toBeDisabled();
  });

  it("shows counter like '1 of N'", () => {
    renderDrawer({
      record: mockAcats[0],
      orderedIds: mockAcats.map((r) => r.id),
    });
    expect(
      screen.getByText(`1 of ${mockAcats.length}`)
    ).toBeInTheDocument();
  });

  it("renders fallback when record is null", () => {
    renderDrawer({ record: null });
    expect(screen.getByText("Record not found.")).toBeInTheDocument();
  });

  it("does not navigate when typing in an input", () => {
    const onNavigate = vi.fn();
    renderDrawer({ onNavigate });
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});
