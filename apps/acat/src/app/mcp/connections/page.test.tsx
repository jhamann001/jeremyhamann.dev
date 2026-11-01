import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));

import McpConnectionsPage from "./page";

describe("MCP connections page", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes("/pat") ? [] : { connectorUrl: "http://localhost:3001/mcp", connections: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("explains that MCP is off in the demo, lists the read-only tools and offers no token form", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "on");
    render(<McpConnectionsPage />);
    expect(screen.getByText("Off in this demo.")).toBeInTheDocument();
    expect(screen.getByText(/tokens can.t be created here/)).toBeInTheDocument();
    expect(screen.getByText("search_acats")).toBeInTheDocument();
    expect(screen.getByText("get_custodian_fee_rules")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. My MacBook")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the token form outside the demo", async () => {
    render(<McpConnectionsPage />);
    expect(screen.getByPlaceholderText("e.g. My MacBook")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mcp/pat"));
  });
});
