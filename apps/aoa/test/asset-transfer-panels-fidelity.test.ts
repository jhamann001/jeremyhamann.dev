import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/app/(authenticated)/asset-transfer/actions", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveAchInitiation: vi.fn(),
  saveCheckTicket: vi.fn(),
}));

import { ChannelsPanel, type ChannelKind } from "@/components/asset-transfer/channels/ChannelsPanel";
import { InstructionList } from "@/components/asset-transfer/mapping/InstructionList";

const ROOT = path.join(process.cwd(), "components/asset-transfer");
const PANEL_DIRS = ["intake", "mapping", "paperwork", "mailing", "receipt", "follow-up", "outcomes", "channels"];

const panelFiles = PANEL_DIRS.flatMap((dir) =>
  readdirSync(path.join(ROOT, dir))
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => `${dir}/${file}`),
);

const mockupCss = readFileSync(path.join(ROOT, "workspace/workspace.css"), "utf8");

function classesIn(html: string): string[] {
  return [...new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/).filter(Boolean)))];
}

function expectMockupClasses(html: string) {
  const missing = classesIn(html).filter((name) => !mockupCss.includes(`.${name}`));
  expect(missing).toEqual([]);
}

describe("Asset Transfer panels use the mockup markup", () => {
  it("covers every owned panel file", () => {
    expect(panelFiles.length).toBeGreaterThanOrEqual(10);
  });

  it.each(panelFiles)("%s imports no CSS module or components/ui", (file) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    expect(source).not.toMatch(/\.module\.css/);
    expect(source).not.toMatch(/@\/components\/ui\b/);
    expect(source).not.toMatch(/\bstyles\.\w+/);
    expect(source).not.toMatch(/@\/components\/transfers\/TransferDetailSection/);
    const literal = [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/));
    expect(literal.filter((name) => !mockupCss.includes(`.${name}`))).toEqual([]);
  });

  it("panel directories keep no CSS modules", () => {
    const modules = PANEL_DIRS.flatMap((dir) =>
      readdirSync(path.join(ROOT, dir)).filter((file) => file.endsWith(".module.css")).map((file) => `${dir}/${file}`),
    );
    expect(modules).toEqual([]);
  });

  it("renders the transfer instructions with mockup classes only", () => {
    const html = renderToStaticMarkup(createElement(InstructionList, {
      enabled: true,
      holdings: [
        { symbol: "SYNA", description: "Synthetic fund A", marketValue: 1200, decision: null, isTransferring: true },
      ],
    } as Parameters<typeof InstructionList>[0]));
    expect(html).toContain('aria-label="Transfer instructions"');
    expectMockupClasses(html);
  });

  it.each<ChannelKind>(["check", "ach", "linked"])("renders the %s channel with mockup classes only", (kind) => {
    const html = renderToStaticMarkup(createElement(ChannelsPanel, {
      transferId: "DEMO-T-0009",
      kind,
      canRecord: true,
      records: {
        latestCheckTicket: null,
        latestAchInitiation: null,
        postedReceiptSaved: false,
        submissionRecorded: false,
      },
    } as Parameters<typeof ChannelsPanel>[0]));
    expect(html).toContain("sectionbody");
    expectMockupClasses(html);
  });
});
