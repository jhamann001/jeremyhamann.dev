import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), "utf8");
}

// The delivery checks (workflows, Terraform, Dependabot) stayed with the production repository; the app-code
// rule below is what this copy can still prove.
describe("operational delivery policy", () => {
  it("emits freshness only after each scheduled ingest commits", () => {
    for (const endpoint of [
      "accounts",
      "activity",
      "appointments",
      "clients",
      "crm-parents",
      "deals",
      "emails",
      "tasks",
    ]) {
      const route = read(`app/api/ingest/${endpoint}/route.ts`);
      expect(route, endpoint).toContain(`logIngestSuccess("${endpoint}")`);
      expect(
        route.indexOf(`logIngestSuccess("${endpoint}")`),
        `${endpoint} freshness signal must follow the transaction`,
      ).toBeGreaterThan(route.lastIndexOf("await withIngestScope"));
    }

    for (const endpoint of [
      "accounts",
      "activity",
      "clients",
      "crm-parents",
      "deals",
      "emails",
      "tasks",
    ]) {
      expect(read(`app/api/ingest/${endpoint}/route.ts`), endpoint).toContain(
        `if (rejected.length === 0) logIngestSuccess("${endpoint}")`,
      );
    }
    expect(read("app/api/ingest/appointments/route.ts")).toContain(
      'if (rows.length > 0) logIngestSuccess("appointments")',
    );

    expect(read("app/api/ingest/slack-checklist/route.ts")).not.toContain(
      "logIngestSuccess",
    );
    expect(read("app/api/ingest/crm-parent-orphans/route.ts")).not.toContain(
      "logIngestSuccess",
    );
  });
});
