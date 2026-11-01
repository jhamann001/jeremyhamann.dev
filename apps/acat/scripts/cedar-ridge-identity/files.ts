import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readJson(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }

/** Create-only writes: changing a review file must use a new filename/digest. */
export function assertRestrictedOutput(path: string): void {
  if (!isAbsolute(path)) throw new Error("ABSOLUTE_EVIDENCE_PATH_REQUIRED");
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(parent);
  const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const within = relative(repo, canonicalParent);
  if (within === "" || (!within.startsWith("..") && !isAbsolute(within))) throw new Error("EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY");
  if ((statSync(parent).mode & 0o077) !== 0) throw new Error("EVIDENCE_DIRECTORY_NOT_PRIVATE");
  if (existsSync(path)) throw new Error("EVIDENCE_FILE_ALREADY_EXISTS");
}

export function writeRestricted(path: string, value: unknown, text = false): void {
  assertRestrictedOutput(path);
  const fd = openSync(path, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text ? String(value) : `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
