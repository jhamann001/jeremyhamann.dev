import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HouseholdsPreview } from "@/components/households/HouseholdsPreview";

describe("Household preview exact-read failure", () => {
  it("keeps links usable and marks every balance unavailable instead of still loading", () => {
    const html = renderToStaticMarkup(createElement(HouseholdsPreview, {
      unavailable: true,
      rows: [{
        sf_id: "synthetic-household", name: "Synthetic Household", stage: "Client",
        lead_advisor_email: "synthetic@example.invalid", advisor_name: null,
      }],
    }));
    expect(html).toContain('href="/households/synthetic-household"');
    expect(html).toContain("Current totals and balances are unavailable.");
    expect(html).toContain("Reload to retry");
    expect(html.match(/Unavailable/g)).toHaveLength(5);
    expect(html).not.toContain("Loading…");
  });
});

function previewMarker() {
  const html = renderToStaticMarkup(createElement(HouseholdsPreview, {
    rows: [{
      sf_id: "synthetic-household", name: "Synthetic Household", stage: "Client",
      lead_advisor_email: "synthetic@example.invalid", advisor_name: null,
    }],
  }));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("preview_marker_missing");
  return script;
}

function markerFrames() {
  const state = {
    now: 0, connected: true, documentVisibility: "visible", cssVisibility: "visible",
    bounds: { width: 180, height: 20 },
  };
  const link = {
    get isConnected() { return state.connected; },
    getBoundingClientRect: () => state.bounds,
  };
  const preview = {
    dataset: { householdsPreview: "true" } as Record<string, string>,
    get isConnected() { return state.connected; },
    querySelector: () => link,
  };
  let frames: Array<() => void> = [];
  runInNewContext(previewMarker(), {
    document: {
      currentScript: { parentElement: preview },
      get visibilityState() { return state.documentVisibility; },
    },
    performance: { now: () => state.now },
    getComputedStyle: () => ({ visibility: state.cssVisibility }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  return {
    state,
    dataset: preview.dataset,
    pending: () => frames.length,
    frame(elapsed = 16) {
      state.now += elapsed;
      const callbacks = frames;
      frames = [];
      for (const callback of callbacks) callback();
    },
  };
}

describe("Household preview rendered-row timing", () => {
  it("waits while a streamed ancestor has no rendered box, then records after reveal", () => {
    const marker = markerFrames();
    marker.state.bounds = { width: 0, height: 0 };
    for (let frame = 0; frame < 4; frame++) marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();

    const revealedAt = marker.state.now;
    marker.state.bounds = { width: 180, height: 20 };
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();
    marker.frame();
    expect(Number(marker.dataset.firstRowsRenderedMs)).toBeGreaterThan(revealedAt);
    expect(marker.pending()).toBe(0);
  });

  it("requires consecutive visible frames and does not record in a hidden document", () => {
    const marker = markerFrames();
    marker.frame();
    marker.state.documentVisibility = "hidden";
    marker.frame();
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();
    marker.state.documentVisibility = "visible";
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeDefined();
  });

  it("waits for CSS visibility even when the row has a layout box", () => {
    const marker = markerFrames();
    marker.state.cssVisibility = "hidden";
    marker.frame();
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();
    marker.state.cssVisibility = "visible";
    marker.frame();
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeDefined();
  });

  it("stops without recording when the preview is detached", () => {
    const marker = markerFrames();
    marker.frame();
    marker.state.connected = false;
    marker.frame();
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();
    expect(marker.pending()).toBe(0);
  });

  it("bounds callbacks when a document stays hidden", () => {
    const marker = markerFrames();
    marker.state.documentVisibility = "hidden";
    marker.frame();
    expect(marker.pending()).toBe(1);
    marker.frame(10_000);
    expect(marker.dataset.firstRowsRenderedMs).toBeUndefined();
    expect(marker.pending()).toBe(0);
  });
});
