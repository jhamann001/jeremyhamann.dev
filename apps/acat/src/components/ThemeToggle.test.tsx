import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import ThemeToggle from "./ThemeToggle";

function renderWithProvider(
  initialTheme: "light" | "dark" | "system" = "light"
) {
  return render(
    <ThemeProvider
      attribute="data-theme"
      defaultTheme={initialTheme}
      enableSystem
    >
      <ThemeToggle />
    </ThemeProvider>
  );
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders an accessible toggle button", () => {
    renderWithProvider("light");
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-label");
  });

  it("cycles themes on click (light -> dark)", () => {
    window.localStorage.setItem("theme", "light");
    renderWithProvider("light");
    const button = screen.getByRole("button");

    expect(button).toHaveAttribute("data-theme-state", "light");

    fireEvent.click(button);

    expect(button).toHaveAttribute("data-theme-state", "dark");
  });

  it("cycles dark -> system", () => {
    window.localStorage.setItem("theme", "dark");
    renderWithProvider("dark");
    const button = screen.getByRole("button");

    expect(button).toHaveAttribute("data-theme-state", "dark");

    fireEvent.click(button);

    expect(button).toHaveAttribute("data-theme-state", "system");
  });

  it("cycles system -> light", () => {
    window.localStorage.setItem("theme", "system");
    renderWithProvider("system");
    const button = screen.getByRole("button");

    expect(button).toHaveAttribute("data-theme-state", "system");

    fireEvent.click(button);

    expect(button).toHaveAttribute("data-theme-state", "light");
  });

  it("persists via next-themes to localStorage", () => {
    renderWithProvider("light");
    const button = screen.getByRole("button");

    fireEvent.click(button);

    // next-themes persists to the 'theme' key by default
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });
});

describe("ThemeProvider wrapper", () => {
  it("exports a functional provider", async () => {
    const { default: ThemeProviderWrapper } = await import("./ThemeProvider");
    const { container } = render(
      <ThemeProviderWrapper attribute="data-theme" defaultTheme="light">
        <div data-testid="child">child</div>
      </ThemeProviderWrapper>
    );
    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument();
  });
});
