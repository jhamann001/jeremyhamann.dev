import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  join(process.cwd(), "app", "(authenticated)", "review-queue", "page.tsx"),
  "utf8",
);

describe("review queue conflict UX", () => {
  it("renders an alert that tells the user to reload and reapply", () => {
    expect(page).toContain('one(sp.queueMessage) === "conflict"');
    expect(page).toContain('role="alert"');
    expect(page).toContain("Reload the latest item, then reapply your decision.");
  });

  it("posts the current validated filter/page return path with each workflow form", () => {
    expect(page).toContain('name="returnTo" value={pageHref(result.page)}');
  });
});
