import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { markCase } from "@/lib/test-flywheel";
import NavRail from "./NavRail";
import { CustodianEditingRetirementProvider } from "./CustodianEditingRetirement";

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

describe("NavRail custodian entry", () => {
  it("shows the Custodians entry when editing is not retired", () => {
    render(<NavRail onNewAcat={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Custodians & Fees" })).toBeTruthy();
    markCase("custodian-edit-retirement", "shows the Custodians entry when editing is not retired");
  });

  it("hides the Custodians entry when editing is retired", () => {
    render(
      <CustodianEditingRetirementProvider retired>
        <NavRail onNewAcat={vi.fn()} />
      </CustodianEditingRetirementProvider>,
    );
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Custodians & Fees" })).toBeNull();
    markCase("custodian-edit-retirement", "hides the Custodians entry when editing is retired");
  });
});
