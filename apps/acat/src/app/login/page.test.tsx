import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockSignIn = vi.fn();
vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    mockSignIn.mockClear();
  });

  it("renders the sign-in heading", () => {
    render(<LoginPage />);
    expect(screen.getByText("Transfer Tracker & Recon")).toBeInTheDocument();
  });

  it("renders a Google sign-in button", () => {
    render(<LoginPage />);
    expect(screen.getByText("Sign in with Google")).toBeInTheDocument();
  });

  it("renders the description text", () => {
    render(<LoginPage />);
    expect(
      screen.getByText(/Sign in with your Cedar Ridge Wealth Google account/)
    ).toBeInTheDocument();
  });

  it("calls signIn with google provider on click", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByText("Sign in with Google"));
    expect(mockSignIn).toHaveBeenCalledWith("google", { callbackUrl: "/" });
  });

  it("shows error message for AccessDenied", () => {
    mockSearchParams = new URLSearchParams("error=AccessDenied");
    render(<LoginPage />);
    expect(
      screen.getByText(/Only example\.com accounts are permitted/)
    ).toBeInTheDocument();
  });

  it("shows generic error for unknown error codes", () => {
    mockSearchParams = new URLSearchParams("error=SomeRandomError");
    render(<LoginPage />);
    expect(
      screen.getByText(/Something went wrong during sign-in/)
    ).toBeInTheDocument();
  });

  it("shows no error when no error param", () => {
    render(<LoginPage />);
    expect(
      screen.queryByText(/Access denied/)
    ).not.toBeInTheDocument();
  });

  it("shows timeout message when reason=timeout", () => {
    mockSearchParams = new URLSearchParams("reason=timeout");
    render(<LoginPage />);
    expect(
      screen.getByText("You were signed out due to inactivity.")
    ).toBeInTheDocument();
  });

  it("does not show timeout message without reason param", () => {
    render(<LoginPage />);
    expect(
      screen.queryByText(/signed out due to inactivity/)
    ).not.toBeInTheDocument();
  });

  it("shows expired message when reason=expired", () => {
    mockSearchParams = new URLSearchParams("reason=expired");
    render(<LoginPage />);
    expect(
      screen.getByText("Your session expired. Please sign in again.")
    ).toBeInTheDocument();
  });

  it("does not show expired message without reason param", () => {
    render(<LoginPage />);
    expect(
      screen.queryByText(/Your session expired/)
    ).not.toBeInTheDocument();
  });

  // Regression: the login page must NEVER render the raw ?error= value,
  // only the hardcoded message from ERROR_MESSAGES. A past family of
  // NextAuth issues exposed reflected-XSS sinks via the error query
  // parameter; we defend against it by mapping through an allow-list.
  it("does not reflect raw error param value into the DOM", () => {
    const payload = '"><img src=x onerror=alert(1)>';
    mockSearchParams = new URLSearchParams({ error: payload });
    const { container } = render(<LoginPage />);
    expect(container.innerHTML).not.toContain(payload);
    expect(container.innerHTML).not.toContain("onerror");
    expect(
      screen.getByText(/Something went wrong during sign-in/)
    ).toBeInTheDocument();
  });

  it("does not reflect raw reason param value into the DOM", () => {
    const payload = '"><script>alert(1)</script>';
    mockSearchParams = new URLSearchParams({ reason: payload });
    const { container } = render(<LoginPage />);
    expect(container.innerHTML).not.toContain(payload);
    expect(container.innerHTML).not.toContain("<script>alert(1)");
    expect(
      screen.queryByText(/signed out due to inactivity/)
    ).not.toBeInTheDocument();
  });
});

describe("LoginPage in the demo", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    mockSignIn.mockClear();
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    vi.stubEnv("NEXT_PUBLIC_PORTFOLIO_URL", "https://jeremyhamann.dev");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("offers the three personas instead of Google", () => {
    render(<LoginPage />);
    for (const name of ["Jordan Reyes", "Marco Ferreira", "Rachel Moss"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.queryByText("Sign in with Google")).not.toBeInTheDocument();
  });

  it("signs in as the chosen persona", () => {
    mockSearchParams = new URLSearchParams("callbackUrl=/records");
    render(<LoginPage />);
    fireEvent.click(screen.getByText("Marco Ferreira"));
    expect(mockSignIn).toHaveBeenCalledWith("persona", { email: "marco.ferreira@example.com", callbackUrl: "/records" });
  });

  it("links back to the portfolio site", () => {
    render(<LoginPage />);
    expect(screen.getByRole("link", { name: /Back to jeremyhamann\.dev/ })).toHaveAttribute("href", "https://jeremyhamann.dev");
  });
});
