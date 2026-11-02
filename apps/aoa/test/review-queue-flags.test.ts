import { afterEach, describe, expect, it } from "vitest";
import { reviewQueueEnabled, reviewQueueMaterializationEnabled } from "@/lib/flags";

const saved = { queue: process.env.REVIEW_QUEUE, materializer: process.env.REVIEW_QUEUE_MATERIALIZATION };
afterEach(() => {
  if (saved.queue === undefined) delete process.env.REVIEW_QUEUE; else process.env.REVIEW_QUEUE = saved.queue;
  if (saved.materializer === undefined) delete process.env.REVIEW_QUEUE_MATERIALIZATION; else process.env.REVIEW_QUEUE_MATERIALIZATION = saved.materializer;
});

describe("review queue rollback seams", () => {
  it("enables each seam only for the exact value 1", () => {
    for (const value of [undefined, "", "0", "true", "yes", "2"]) {
      if (value === undefined) { delete process.env.REVIEW_QUEUE; delete process.env.REVIEW_QUEUE_MATERIALIZATION; }
      else { process.env.REVIEW_QUEUE = value; process.env.REVIEW_QUEUE_MATERIALIZATION = value; }
      expect(reviewQueueEnabled()).toBe(false);
      expect(reviewQueueMaterializationEnabled()).toBe(false);
    }
    process.env.REVIEW_QUEUE = "1";
    process.env.REVIEW_QUEUE_MATERIALIZATION = "1";
    expect(reviewQueueEnabled()).toBe(true);
    expect(reviewQueueMaterializationEnabled()).toBe(true);
  });

  it("keeps visibility and materialization independent", () => {
    process.env.REVIEW_QUEUE = "1";
    process.env.REVIEW_QUEUE_MATERIALIZATION = "0";
    expect(reviewQueueEnabled()).toBe(true);
    expect(reviewQueueMaterializationEnabled()).toBe(false);
  });
});
