import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import RecordHistoryTab from "./RecordHistoryTab";
import { jsonFetcher } from "@/lib/fetcher";
import { mockAcats } from "@/lib/mock-data";

describe("RecordHistoryTab", () => {
  it("shows who changed a field and its before and after values", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{
        id: "AUD-1",
        action: "update",
        field: "status",
        oldValue: "PendingReview",
        newValue: "Completed",
        performedBy: "ops@example.com",
        timestamp: "2026-09-09T14:00:00.000Z",
      }]),
    });

    render(
      <SWRConfig value={{ fetcher: jsonFetcher, provider: () => new Map(), dedupingInterval: 0 }}>
        <RecordHistoryTab acat={mockAcats[0]} />
      </SWRConfig>
    );

    expect(await screen.findByText("Status changed")).toBeInTheDocument();
    expect(screen.getByText("Pending Review")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("ops@example.com")).toBeInTheDocument();
  });
});
