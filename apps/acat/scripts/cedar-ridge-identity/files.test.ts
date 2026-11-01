// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRestrictedOutput, writeRestricted } from "./files";
import { parseArgs } from "./cli";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
describe("restricted evidence output and CLI inputs", () => {
  it("writes private create-only files and will not replace approved evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "identity-check-evidence-test-")); directories.push(directory); chmodSync(directory, 0o700);
    const path = join(directory, "manifest.json");
    writeRestricted(path, { synthetic: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ synthetic: true });
    expect(() => writeRestricted(path, { synthetic: false })).toThrow("EVIDENCE_FILE_ALREADY_EXISTS");
  });
  it("rejects Git-root, relative and permissive output locations before writes", () => {
    expect(() => assertRestrictedOutput("relative.json")).toThrow("ABSOLUTE_EVIDENCE_PATH_REQUIRED");
    expect(() => assertRestrictedOutput(resolve("blocked-client-data.json"))).toThrow("EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY");
    const directory = mkdtempSync(join(tmpdir(), "identity-check-evidence-test-")); directories.push(directory); chmodSync(directory, 0o755);
    expect(() => assertRestrictedOutput(join(directory, "blocked.json"))).toThrow("EVIDENCE_DIRECTORY_NOT_PRIVATE");
  });
  it("defaults to help and rejects duplicate or valueless operator options", () => {
    expect(parseArgs([])).toEqual({ command: "help", values: {} });
    expect(() => parseArgs(["apply", "--actor", "a", "--actor", "b"])).toThrow("DUPLICATE_ARGUMENT");
    expect(() => parseArgs(["apply", "--approved-digest"])).toThrow("INVALID_ARGUMENTS");
  });
});
