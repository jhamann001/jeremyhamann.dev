import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const runner = dockerfile.split("FROM node:20-slim AS runner")[1] ?? "";

describe("app runner image", () => {
  it("upgrades Debian packages and removes npm before dropping privileges", () => {
    const upgrade = runner.indexOf("apt-get upgrade");
    const dropNpm = runner.indexOf("/usr/local/lib/node_modules/npm");
    const dropPrivileges = runner.indexOf("USER node");
    expect(upgrade).toBeGreaterThan(-1);
    expect(dropNpm).toBeGreaterThan(upgrade);
    expect(dropPrivileges).toBeGreaterThan(dropNpm);
    expect(runner).toContain("CMD [\"node\", \"server.js\"]");
  });
});
