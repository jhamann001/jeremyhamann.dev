import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import NavRail from "./NavRail";

const pushMock = vi.fn();
const pathnameMock = vi.fn<() => string>().mockReturnValue("/records");
const signOutMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => pathnameMock(),
}));

vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
  useSession: () => ({
    data: {
      user: {
        email: "jeremy@example.com",
        name: "Jeremy H",
        role: "ADMIN",
      },
    },
    status: "authenticated",
  }),
}));

describe("NavRail", () => {
  const onNewAcat = vi.fn();
  const onRefresh = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    pushMock.mockClear();
    signOutMock.mockClear();
    onNewAcat.mockClear();
    onRefresh.mockClear();
    pathnameMock.mockReturnValue("/records");
  });

  it("highlights the Records button on /records", () => {
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    const btn = screen.getByRole("button", { name: "All Records" });
    expect(btn.getAttribute("aria-current")).toBe("page");
    expect(btn.getAttribute("data-active")).toBe("true");
  });

  it("navigates to / when Dashboard is clicked", () => {
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("navigates to /records when All Records is clicked", () => {
    pathnameMock.mockReturnValue("/");
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "All Records" }));
    expect(pushMock).toHaveBeenCalledWith("/records");
  });

  it("calls onNewAcat when the plus button is clicked", () => {
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "New Transfer" }));
    expect(onNewAcat).toHaveBeenCalledOnce();
  });

  it("shows User Management button for ADMIN users", () => {
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    expect(
      screen.getByRole("button", { name: "User Management" })
    ).toBeInTheDocument();
  });

  it("triggers signOut when sign-out button clicked", () => {
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOutMock).toHaveBeenCalled();
  });

  it("calls onRefresh when Refresh is clicked", async () => {
    render(<NavRail onNewAcat={onNewAcat} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("omits the Refresh button when no onRefresh is provided", () => {
    render(<NavRail onNewAcat={onNewAcat} />);
    expect(
      screen.queryByRole("button", { name: "Refresh" })
    ).not.toBeInTheDocument();
  });
});
