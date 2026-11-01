/**
 * Static source guardrails G1–G16 over src/** (and, for the Wave A rules, over the migration SQL and
 * prisma/sql/runtime-roles.sql, because the database is what actually holds those lines) (docs/ARCHITECTURE.md §g S2 tests; I1, I3, I5, I11, I14,
 * convention 12, Decision #57).
 *
 * Every rule iterates over the files that exist at scan time and passes vacuously when a slice has not
 * landed yet. The scan is tolerant of files other slices are still writing: unreadable files are skipped,
 * comments are stripped before pattern checks, and imports are parsed structurally (type-only imports are
 * recognised and exempt where the contract says so).
 */
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The ONLY runtime import in this file, and it is what makes G16's second half a two-sided pin: the
// opening-message view's WHERE is compared against these exact constants, so moving a source onto the
// allowlist without rebuilding the view (or the reverse) fails here. `src/types/domain.ts` is L0 and
// side-effect free — it imports nothing but types.
import { INTAKE_RELEASE_EXTERNAL_ID_PREFIX, REQUESTER_AUTHORED_SOURCES, TICKET_SOURCES } from "@/types/domain";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const SELF = "src/lib/guardrails.test.ts";
const AUTH_ROUTE = "src/app/api/auth/[...nextauth]/route.ts";
/** The Cloud Run / deploy-smoke probe: public, sessionless, no audit row — the second and last G3 exemption. */
const HEALTH_ROUTE = "src/app/api/health/route.ts";
const SIGN_IN_ACTIONS = "src/app/sign-in/sign-in.actions.ts";
const CLIENT_ROUTE = "src/app/api/client/tickets/[id]/route.ts";
const CLIENT_VIEW = "src/server/client-view.ts";

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

type SourceFile = {
  /** POSIX path relative to the repo root, e.g. "src/lib/db.ts". */
  rel: string;
  /** Raw text. */
  text: string;
  /** Text with comments stripped — used for every pattern check. */
  code: string;
};

function walk(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(abs, out);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(abs);
    }
  }
}

/** Removes block comments, whole-line `//` comments and trailing ` //` comments (a `://` URL is kept). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(?<!:)\s\/\/.*$/gm, "");
}

function loadSources(): SourceFile[] {
  const files: string[] = [];
  walk(SRC, files);
  const out: SourceFile[] = [];
  for (const abs of files.sort()) {
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue; // being written by another slice right now
    }
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    out.push({ rel, text, code: stripComments(text) });
  }
  return out;
}

const SOURCES = loadSources();
const byRel = new Map(SOURCES.map((s) => [s.rel, s]));

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

type ImportRef = {
  /** Specifier as written. */
  specifier: string;
  /** Specifier normalised: relative paths resolved to `@/…`, extensions dropped. */
  id: string;
  /** `import type …` or every named specifier prefixed with `type`. */
  typeOnly: boolean;
  /** Named / default specifiers ("default" for a default import, "*" for a namespace import). */
  names: string[];
  namespace: boolean;
  /** Dynamic `import()` or `require()`. */
  dynamic: boolean;
};

const STATIC_IMPORT_RE =
  /\bimport\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+))\s+from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;
const EXPORT_FROM_RE = /\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;

function normalizeSpecifier(spec: string, fileRel: string): string {
  let id = spec;
  if (id.startsWith("./") || id.startsWith("../")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), id));
    id = resolved.startsWith("src/") ? `@/${resolved.slice(4)}` : resolved;
  }
  id = id.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  if (id.endsWith("/index")) id = id.slice(0, -"/index".length);
  return id;
}

function parseClause(clause: string): { names: string[]; namespace: boolean; allType: boolean } {
  const names: string[] = [];
  let namespace = false;
  let sawValueSpecifier = false;
  let rest = clause.trim();
  const defaultMatch = /^([\w$]+)\s*,\s*/.exec(rest);
  if (defaultMatch) {
    names.push("default");
    sawValueSpecifier = true;
    rest = rest.slice(defaultMatch[0].length).trim();
  }
  if (rest.startsWith("*")) {
    namespace = true;
    names.push("*");
    sawValueSpecifier = true;
  } else if (rest.startsWith("{")) {
    const inner = rest.slice(1, rest.lastIndexOf("}"));
    for (const part of inner.split(",")) {
      const spec = part.trim();
      if (!spec) continue;
      const isType = /^type\s+/.test(spec);
      const bare = spec.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!bare) continue;
      names.push(bare);
      if (!isType) sawValueSpecifier = true;
    }
  } else if (rest.length > 0) {
    names.push("default");
    sawValueSpecifier = true;
  }
  return { names, namespace, allType: names.length > 0 && !sawValueSpecifier };
}

function extractImports(file: Pick<SourceFile, "rel" | "code">): ImportRef[] {
  const out: ImportRef[] = [];
  const { code, rel } = file;

  for (const m of code.matchAll(STATIC_IMPORT_RE)) {
    if (m[4] !== undefined) {
      out.push({ specifier: m[4], id: normalizeSpecifier(m[4], rel), typeOnly: false, names: [], namespace: false, dynamic: false });
      continue;
    }
    const typeKeyword = m[1] !== undefined;
    const clause = parseClause(m[2]);
    out.push({
      specifier: m[3],
      id: normalizeSpecifier(m[3], rel),
      typeOnly: typeKeyword || clause.allType,
      names: clause.names,
      namespace: clause.namespace,
      dynamic: false,
    });
  }
  for (const m of code.matchAll(EXPORT_FROM_RE)) {
    const typeKeyword = m[1] !== undefined;
    const clause = m[2].startsWith("*") ? { names: ["*"], namespace: true, allType: false } : parseClause(m[2]);
    out.push({
      specifier: m[3],
      id: normalizeSpecifier(m[3], rel),
      typeOnly: typeKeyword || clause.allType,
      names: clause.names,
      namespace: clause.namespace,
      dynamic: false,
    });
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT_RE)) {
    out.push({ specifier: m[1], id: normalizeSpecifier(m[1], rel), typeOnly: false, names: ["*"], namespace: true, dynamic: true });
  }
  return out;
}

/** True when the comment-stripped code opens with the directive as its first statement. */
function hasDirective(code: string, directive: "use client" | "use server"): boolean {
  const m = /^\s*(["'])(use client|use server)\1\s*;?/.exec(code);
  return m !== null && m[2] === directive;
}

const NODE_BUILTINS = new Set(builtinModules);

function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || NODE_BUILTINS.has(spec);
}

function isPrismaValueImport(ref: ImportRef): boolean {
  return (ref.specifier === "@prisma/client" || ref.specifier.startsWith("@prisma/client/") || ref.specifier === ".prisma/client") && !ref.typeOnly;
}

const L1_MODULES = [
  "src/lib/errors.ts",
  "src/lib/rbac.ts",
  "src/lib/dev-login.ts",
  "src/lib/okta-groups.ts",
  // The temporary Google domain gate. `src/auth.config.ts` imports it, so it is in the edge bundle and is
  // bound by exactly the rules auth.config is: no env module, no Prisma value, no node builtin. Pinning it
  // here is what stops a later edit reaching for `@/lib/env` because it is "just a config read" — that one
  // import would break the middleware for every route, which is a worse failure than the typing it saves.
  "src/lib/google-domain.ts",
  "src/lib/client-ip.ts",
  "src/lib/pii.ts",
  "src/lib/sla.ts",
  "src/lib/routing.ts",
  "src/lib/ticket-policy.ts",
  "src/lib/disclaimers.ts",
  "src/lib/macro-template.ts",
  "src/lib/format.ts",
  // The firm clock (integration round 3, requested by the build record
  // §3). It imports nothing at all, so it already satisfied G2 — pinning it here is what stops a future
  // edit quietly giving it an L2 import. It is shared BY an L1 component module (`flag-state.ts`) and by
  // L4 server code (`followUpWhere`), which is exactly why it has to sit at the bottom.
  "src/lib/firm-time.ts",
  // The app-runtime structured logger (security scanner sweep, 2026-09-20). It replaces the
  // `console.error(…, e)` calls CWE-209 flags, which means route handlers, server actions, server
  // components AND middleware all import it. Pinning it here is what keeps it importable from every
  // one of those: it may hold nothing from L2+ and no node builtin, so `process.stdout` stays a
  // guarded global read rather than a `node:` import that would break the edge bundle.
  "src/lib/logger.ts",
];

const CLIENT_FORBIDDEN_MODULES = [
  "@/lib/db",
  "@/lib/audit",
  "@/lib/env",
  "@/lib/request-context",
  "@/lib/session",
  "@/auth",
  // Constant-time comparison (security scanner sweep, 2026-09-20; CWE-208). It imports `node:crypto`, so a client
  // file that reached for it would not build — and the reach is a plausible mistake, because the
  // admin webhook sheet has its own "type the signing secret to confirm" equality that security scanner flags
  // under the SAME rule. That one is a UI confirmation and must be restructured, not made
  // constant-time;
  "@/lib/safe-equal",
  // Test support (security scanner sweep, 2026-09-20). `@/test-support/capture-logs` imports `vitest` and hooks
  // `process.stdout`/`process.stderr`; `@/test-support/db-url` composes connection strings. Neither
  // has any business in a shipped bundle, and they live under `src/` only so the `@/` path and the
  // repo tsconfig reach them — so the G1 list is what keeps them out of a client file.
  "@/test-support/capture-logs",
  "@/test-support/db-url",
];

/**
 * CONTRACT §9: the two ticket-page mount points are async SERVER components that own their own data
 * load, because the ticket page is foundation-owned and cannot import the panels' server modules on
 * their behalf. They may reach a `@/server/*` read module and nothing else — `@/lib/db`,
 * `@/lib/audit`, `@/lib/env`, `@/lib/session`, `@/auth`, Prisma value imports and `@/app/*` stay
 * forbidden for them too, and a third server import anywhere under `src/components/**` still fails.
 * Amended by the integration pass on 2026-09-19;
 */
const SERVER_COMPONENT_MOUNT_POINTS: readonly string[] = [
  "src/components/ticket/requester-history.tsx",
  "src/components/ticket/attachments/attachments-panel.tsx",
  // Wave B adds four more, on exactly the same terms and for exactly the same reason: the ticket page
  // is foundation-owned and cannot import four slices' server modules on their behalf, so each panel
  // owns its own load behind its own Suspense boundary. Everything else
  // G1 forbids is still forbidden for them — `@/lib/db`, `@/lib/audit`, `@/lib/env`, `@/lib/session`,
  // `@/auth`, Prisma value imports and `@/app/*` — and G1b keeps this from rotting into a general
  // exemption by failing when a listed file stops existing or acquires a `"use client"` directive.
  "src/components/ticket/links/links-panel.tsx",
  "src/components/ticket/duplicate-banner.tsx",
  "src/components/ticket/identity-verification.tsx",
  "src/components/inbox/ticket-followers.tsx",
];

function isNonActionsServerModule(id: string): boolean {
  return id.startsWith("@/server/") && !id.endsWith(".actions");
}

/** Everything at layer L2 and above, by normalised id. */
function isL2Plus(id: string): boolean {
  return (
    CLIENT_FORBIDDEN_MODULES.includes(id) ||
    id.startsWith("@/server/") ||
    id.startsWith("@/components/") ||
    id.startsWith("@/app/")
  );
}

/** Opening `<Link …>` tags, tracking `{}` depth and quotes so a `>` inside an attribute expression does not end the tag. */
function linkTags(code: string): string[] {
  const tags: string[] = [];
  const re = /<Link\b/g;
  for (const m of code.matchAll(re)) {
    const start = m.index ?? 0;
    let depth = 0;
    let quote: string | null = null;
    let i = start;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (quote !== null) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth <= 0) break;
    }
    tags.push(code.slice(start, Math.min(i + 1, code.length)));
  }
  return tags;
}

function isApiRoute(rel: string): boolean {
  return rel.startsWith("src/app/api/") && rel.endsWith("/route.ts");
}

/**
 * EVERY App Router route handler, not only the ones under `/api`. Two live outside it —
 * `src/app/(app)/tickets/wm/[number]/route.ts` and `src/app/(app)/compliance/reviews/export/route.ts` —
 * and Next.js applies exactly the same module contract to them.
 */
function isRouteHandler(rel: string): boolean {
  return rel.startsWith("src/app/") && rel.endsWith("/route.ts");
}

/**
 * Top-level RUNTIME export names of a module, in source order. Handles the four spellings this
 * repository uses: `export const X`, `export function X`, `export async function X` and the
 * destructuring `export const { GET, POST } = handlers` that the Auth.js route writes. Type-only
 * exports are skipped — they are erased before anything sees them — and `export default` is reported
 * under the name `default` so a rule can refuse it.
 */
function topLevelExportNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/^export\s+(?!type\s|interface\s)(?:declare\s+)?(.*)$/gm)) {
    const rest = m[1];
    if (/^default\b/.test(rest)) {
      names.push("default");
      continue;
    }
    const destructured = /^(?:const|let|var)\s*\{([^}]*)\}/.exec(rest);
    if (destructured) {
      for (const part of destructured[1].split(",")) {
        const name = part.split(":").pop()?.trim().replace(/\s*=.*$/, "");
        if (name) names.push(name);
      }
      continue;
    }
    const declared = /^(?:const|let|var|(?:async\s+)?function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (declared) names.push(declared[1]);
  }
  return names;
}

/** Reads a repo file outside src/ (migrations, SQL). Returns "" when absent, so a rule can say so itself. */
function readRepoFile(rel: string): string {
  try {
    return readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
}

/** The SQL of one migration folder. Wave A rules read the DB's own guarantees, not the TypeScript. */
function readMigration(folder: string): string {
  return readRepoFile(`prisma/migrations/${folder}/migration.sql`);
}

/**
 * Every migration folder, in creation order. Prisma's names are timestamp-prefixed, so lexicographic
 * order IS creation order — the order the database applied them in.
 */
function migrationFolders(): string[] {
  try {
    return readdirSync(path.join(ROOT, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every migration that has SQL, in creation order. */
function migrationSources(): { rel: string; sql: string }[] {
  return migrationFolders()
    .map((folder) => ({ rel: `prisma/migrations/${folder}/migration.sql`, sql: readMigration(folder) }))
    .filter((m) => m.sql.trim() !== "");
}

/**
 * Every migration's SQL concatenated in creation order — the statement stream the database actually
 * saw.
 *
 * The DB-level Wave B rules read THIS rather than a named folder, and that is the whole difference
 * between a rule and a decoration. A guardrail whose only input is one migration name stops asserting
 * anything the moment the object it guards moves: the objects stay where the constant points, or the
 * constant has to be maintained by whoever writes the next migration. That failure has already
 * happened here once — `20260920000300_wave_b_integration_r1` had to write its `ReportingStatusChange`
 * REVOKE by hand precisely because the privilege rule scanned a different file — so the input is
 * derived instead. A REVOKE, a GRANT, a trigger or a view written in ANY migration counts, and a new
 * migration cannot land outside the scan.
 */
function allMigrationSql(): string {
  return migrationSources()
    .map((m) => m.sql)
    .join("\n");
}

/** The migration that LAST runs `CREATE VIEW "<view>"`, or null when no migration creates it. */
function migrationDefiningView(view: string): { rel: string; sql: string } | null {
  // The view name is CAPTURED by a literal pattern and compared as a string, rather than interpolated
  // into `new RegExp(...)` — two security scanner findings on the old line, CWE-185
  // and CWE-1333. the build record The whitespace runs are
  // bounded, which is what makes the scan linear; no SQL keyword gap is 40 characters wide.
  const defining = migrationSources().filter((m) =>
    [...m.sql.matchAll(/\bCREATE\s{1,40}(?:OR\s{1,40}REPLACE\s{1,40})?VIEW\s{1,40}"([A-Za-z0-9_]{1,80})"/gi)].some(
      (c) => c[1] === view,
    ),
  );
  return defining.length > 0 ? defining[defining.length - 1] : null;
}

/**
 * Every table `prisma/schema.prisma` declares, by its DATABASE name (`@@map` wins where a model has
 * one). The Wave B table universe is derived from this rather than typed out, so a model added later
 * is inside the guardrails' scope the moment it lands in the schema — which is what makes "a
 * fourteenth table fails by omission" true rather than aspirational.
 */
function prismaModels(schema: string): string[] {
  const names: string[] = [];
  for (const model of schema.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(model[2]);
    names.push(mapped ? mapped[1] : model[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// SQL parsing (privilege rules)
//
// The privilege guardrails used to be file-wide regexes. A file-wide `[\s\S]*?` match can be satisfied
// by text from a *different* statement, which makes a rule pass for reasons unrelated to what it
// asserts, so everything below works one statement at a time and compares parsed identifiers rather
// than raw substrings.
// ---------------------------------------------------------------------------

const WAVE_A_MIGRATION = "20260919000200_wave_a_constraints";
const RUNTIME_ROLES_SQL = "prisma/sql/runtime-roles.sql";

/** The six tables Wave A adds. None of them is ever readable by the client-API role. */
const WAVE_A_TABLES = ["IngestReceipt", "SuspendedIntake", "MessageDelivery", "Attachment", "SlaAlert", "JobCursor"];

/** Every table the schema declares today, by database name. */
const PRISMA_MODELS = prismaModels(readRepoFile("prisma/schema.prisma"));

/**
 * The tables that existed BEFORE Wave B — the core schema plus Wave A. This is a closed historical
 * set: it is what the database already held when Wave B opened, so it cannot grow, and G18 asserts
 * every one of them is still declared (a renamed or dropped model would otherwise inflate the derived
 * Wave B set below and weaken both rules by widening them).
 */
const PRE_WAVE_B_TABLES = [
  "User",
  "Account",
  "Session",
  "VerificationToken",
  "Queue",
  "SLA",
  "Ticket",
  "Comment",
  "Macro",
  "AuditLog",
  ...WAVE_A_TABLES,
];

/**
 * The thirteen tables Wave B adds. None of them is ever readable by the client-API role either.
 *
 * DERIVED from `prisma/schema.prisma`, not typed out: Wave B's tables are whatever the schema has
 * beyond the pre-Wave-B set. A literal array can only fail when someone remembers to extend it, which
 * is the opposite of what G17 and G18 claim — with the derivation, a fourteenth model fails G17 (no
 * migration revokes it from the client role) and G18 (it is in neither the guarded nor the excepted
 * list) the moment it is declared, whether or not anyone thought about the guardrails.
 */
const WAVE_B_TABLES = PRISMA_MODELS.filter((table) => !PRE_WAVE_B_TABLES.includes(table)).sort();

/**
 * The only relations the client-API role may hold any table privilege on, ever.
 *
 * Decision #117 (amended) adds the THIRD, and it is an opt-in of exactly the kind this rule exists to
 * force: "ClientVisibleOpeningMessage" is granted BECAUSE `description`, `source` and `externalId` are
 * revoked from `"Ticket"` below. A view whose WHERE is the policy is strictly narrower than three
 * columns readable for every ticket — and like the comment view it is column-scoped by construction,
 * so granting it whole is safe in a way granting `"Ticket"` whole never was.
 */
const PUBLIC_READABLE = ["Ticket", "ClientVisibleComment", "ClientVisibleOpeningMessage"];

/**
 * `"Ticket"` is granted to the client-API role COLUMN BY COLUMN, never table-wide. Wave A widened the
 * table with requester PII (`requesterPhone`), identity pointers (`householdId`, `requesterExternalId`),
 * compliance state (`isComplaint`, `complaintFiledAt`, `escalationTarget`), routing (`brand`, `source`,
 * `linkedFromTicketId`) and vendor keys (`externalRef`, `externalId`) — a table grant would have handed
 * the client role every one of them the moment the column landed, because a table privilege covers
 * future columns too. This list is exactly the projection of `getClientTicketView`
 * (src/server/client-view.ts) AND of the shared `CLIENT_TICKET_SELECT` literal the list and by-number
 * reads use; G15 pins the grant against BOTH of them, so a new `"Ticket"` column is opt-in for the
 * client role the same way a new table is (amended).
 *
 * **Decision #117 exercised that opt-in, and then gave it back.** Its first shape granted three more
 * columns — `description` (the message a thread opens with), `source` (what decides whose words that
 * is) and `externalId` (the released-held-mail marker) — and enforced the gate in `openingMessageFor`.
 * That put a disclosure rule in application code, where the whole point of `ClientVisibleComment` is
 * that a coding mistake cannot produce an internal note because the DATABASE will not return one. The
 * amended shape reads the opening entry from `ClientVisibleOpeningMessage`, whose WHERE carries both
 * gates, so all three columns are REVOKEd and the list below is Wave A's ten again. The rule is
 * unchanged in force throughout: still column-scoped, still REVOKE-before-GRANT, still pinned to both
 * TypeScript projections, so the next column is opt-in exactly as those three were.
 */
const CLIENT_TICKET_COLUMNS = [
  "id",
  "number",
  "subject",
  "status",
  "priority",
  "category",
  "createdAt",
  "updatedAt",
  "resolvedAt",
  "requesterEmail",
];

/**
 * The exact projection of the client-visible view — an allowlist, not a denylist.
 *
 * Wave B added ONE column, `retracted`, and changed ONE: `body` is the empty string for
 * a retracted comment. Both are read out of the migration that DEFINES the view today, not out of the
 * Wave A one — see `migrationDefiningView()`.
 */
const CLIENT_VISIBLE_COLUMNS = ["id", "ticketId", "body", "disclaimerKey", "authorKind", "createdAt", "retracted"];

/**
 * Splits SQL into statements on `;`, ignoring semicolons inside string or quoted-identifier literals.
 * Line comments are dropped first. A `DO $$ … END $$` block is split by its *inner* statements, which
 * is exactly what the privilege rules want: every GRANT/REVOKE is judged on its own text.
 */
function sqlStatements(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, " ");
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of text) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ";" && !inSingle && !inDouble) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

type PrivilegeStatement = {
  kind: "GRANT" | "REVOKE";
  /** Privilege list as written, e.g. `ALL` or `SELECT, INSERT`. */
  privileges: string;
  /** Object list as written, e.g. `"A", public."B"` or `ALL TABLES IN SCHEMA public`. */
  objects: string;
  /** Grantee role names, lower-cased. */
  roles: string[];
  /** Column names of a column-scoped privilege list (`SELECT (a, "b")`), or null when there is none. */
  columns: string[] | null;
  /** Privilege keywords written WITHOUT a column list, upper-cased: each covers the whole table. */
  tableWide: string[];
};

/** Objects that are not tables, so the table allowlist does not apply to them. */
const NON_TABLE_OBJECT =
  /^(DATABASE|SCHEMA|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|TYPE|DOMAIN|LANGUAGE|TABLESPACE|LARGE\s+OBJECT|FOREIGN|PARAMETER|ALL\s+(SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES))\b/i;

const PRIVILEGE_RE =
  /\b(GRANT|REVOKE)\s+((?:GRANT\s+OPTION\s+FOR\s+)?[\s\S]*?)\s+ON\s+([\s\S]*?)\s+(TO|FROM)\s+([\s\S]*)$/i;

/**
 * Splits a privilege list into its column-scoped and table-wide halves.
 *
 *   `SELECT (id, "createdAt")` -> columns ["id", "createdAt"], tableWide []
 *   `SELECT, INSERT (x)`       -> columns ["x"],               tableWide ["SELECT"]
 *   `ALL`                      -> columns null,                tableWide ["ALL"]
 *
 * The distinction is the whole point of the `"Ticket"` rule: a privilege written without a column list
 * covers every column the table has AND every column it will ever gain, so it can never be the grant a
 * column allowlist is asserted against.
 */
function parsePrivilegeColumns(privileges: string): { columns: string[] | null; tableWide: string[] } {
  const columns: string[] = [];
  const tableWide: string[] = [];
  let scoped = false;
  for (const item of splitTopLevel(privileges)) {
    const m = /^([A-Za-z][A-Za-z\s]*?)\s*\(([\s\S]*)\)$/.exec(item);
    if (!m) {
      tableWide.push(item.toUpperCase());
      continue;
    }
    scoped = true;
    for (const col of splitTopLevel(m[2])) columns.push(col.replace(/"/g, "").trim());
  }
  return { columns: scoped ? columns : null, tableWide };
}

/** Parses one GRANT/REVOKE statement. Returns null for anything else (including role-membership grants). */
function parsePrivilegeStatement(stmt: string): PrivilegeStatement | null {
  const m = PRIVILEGE_RE.exec(stmt);
  if (!m) return null;
  const kind = m[1].toUpperCase() as "GRANT" | "REVOKE";
  // `GRANT … FROM` / `REVOKE … TO` is not real SQL; refuse to guess at it.
  if ((kind === "GRANT") !== (m[4].toUpperCase() === "TO")) return null;
  const roles = m[5]
    .replace(/\b(WITH\s+(GRANT|ADMIN)\s+OPTION|CASCADE|RESTRICT|GRANTED\s+BY)\b[\s\S]*/gi, " ")
    .split(",")
    .map((part) => (/[A-Za-z_][A-Za-z0-9_$]*/.exec(part.trim()) ?? [""])[0].toLowerCase())
    .filter(Boolean);
  const privileges = m[2].trim();
  return { kind, privileges, objects: m[3].trim(), roles, ...parsePrivilegeColumns(privileges) };
}

/**
 * `"A", public."B", TABLE c` -> `["a", "b", "c"]`. Quotes, the `TABLE` noise word and the schema
 * qualifier are stripped and the name is lower-cased, so an unquoted or schema-qualified spelling of a
 * table cannot slip past a check written with the codebase's own quoted camelCase spelling.
 */
function objectNames(objects: string): string[] {
  return objects
    .split(",")
    .map((o) => o.trim().replace(/^TABLE\s+/i, ""))
    .map((o) => o.split(".").pop() ?? "")
    .map((o) => o.replace(/"/g, "").trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Case-insensitive whole-word search — what an interpolated `\\b…\\b` pattern did, without building one
 * from a non-literal at run time (security scanner CWE-185). `\\b` sits between a word character
 * (`[A-Za-z0-9_]`) and anything else, including the start and end of the string, which is exactly the
 * boundary test below.
 */
const WORD_CHAR = /[A-Za-z0-9_]/;
function containsWord(haystack: string, word: string): boolean {
  const text = haystack.toLowerCase();
  const needle = word.toLowerCase();
  if (needle.length === 0) return false;
  for (let from = 0; ; from++) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text.charAt(at - 1);
    const after = text.charAt(at + needle.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at;
  }
}

/** One line of SQL, whitespace-collapsed, for a failure message. */
function squash(stmt: string): string {
  const one = stmt.replace(/\s+/g, " ").trim();
  return one.length > 140 ? `${one.slice(0, 137)}…` : one;
}

/**
 * Every way the client-API role could end up able to read something it must not,
 * judged per statement:
 *
 *  - a blanket `GRANT … ON ALL TABLES IN SCHEMA … TO <public role>` (names no table at all);
 *  - an `ALTER DEFAULT PRIVILEGES … TO <public role>` (is not a GRANT statement at all, and grants
 *    every *future* table);
 *  - a role-membership `GRANT <role> TO <public role>` (no ON clause; inherits the target's grants);
 *  - a table grant to the public role for anything outside `readable` — whatever the spelling;
 *  - any `tables` entry not covered by an explicit `REVOKE ALL … FROM <public role>`;
 *  - for a `columnScoped` relation (`"Ticket"`), a grant that is not column-scoped, or whose column
 *    list is not exactly the allowlist, or that is not preceded in the same file by a
 *    `REVOKE ALL … FROM <public role>` — without which a table-wide grant left by an earlier version
 *    of the script survives the re-run, since a column GRANT never narrows an existing table grant.
 */
function clientRoleGrantViolations(
  rel: string,
  sql: string,
  tables: string[],
  readable: string[],
  opts: { role?: string; columnScoped?: Record<string, readonly string[]> } = {},
): string[] {
  const role = opts.role ?? "wm_helpdesk_public";
  const violations: string[] = [];
  const allowed = new Set(readable.map((t) => t.toLowerCase()));
  const columnScoped = new Map<string, Set<string>>(
    Object.entries(opts.columnScoped ?? {}).map(([table, cols]) => [table.toLowerCase(), new Set(cols)]),
  );
  /** Statement index of the first `REVOKE ALL` / first GRANT naming each table, for the ordering rule. */
  const revokedAt = new Map<string, number>();
  const grantedAt = new Map<string, number>();
  const grantedColumns = new Map<string, Set<string>>();
  const namesRole = (stmt: string): boolean => containsWord(stmt, role);

  const statements = sqlStatements(sql);
  for (let index = 0; index < statements.length; index++) {
    const stmt = statements[index];
    if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(stmt)) {
      if (namesRole(stmt)) violations.push(`${rel}: ALTER DEFAULT PRIVILEGES names ${role} — ${squash(stmt)}`);
      continue;
    }
    const parsed = parsePrivilegeStatement(stmt);
    if (!parsed) {
      if (/^GRANT\b/i.test(stmt) && !/\bON\b/i.test(stmt) && namesRole(stmt)) {
        violations.push(`${rel}: role-membership GRANT to ${role} — ${squash(stmt)}`);
      }
      continue;
    }
    if (!parsed.roles.includes(role.toLowerCase())) continue;
    if (parsed.kind === "GRANT") {
      if (/\bALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(parsed.objects)) {
        violations.push(`${rel}: blanket GRANT on all tables to ${role} — ${squash(stmt)}`);
        continue;
      }
      if (NON_TABLE_OBJECT.test(parsed.objects)) continue; // CONNECT ON DATABASE, USAGE ON SCHEMA, …
      for (const name of objectNames(parsed.objects)) {
        if (!allowed.has(name)) {
          violations.push(`${rel}: ${name} granted to ${role} — ${squash(stmt)}`);
          continue;
        }
        const scoped = columnScoped.get(name);
        if (!scoped) continue;
        if (!grantedAt.has(name)) grantedAt.set(name, index);
        if (parsed.columns === null) {
          violations.push(`${rel}: ${name} granted table-wide to ${role} — a column grant is required — ${squash(stmt)}`);
          continue;
        }
        if (parsed.tableWide.length > 0) {
          violations.push(
            `${rel}: ${name} also granted table-wide (${parsed.tableWide.join(", ")}) to ${role} — ${squash(stmt)}`,
          );
        }
        const seen = grantedColumns.get(name) ?? new Set<string>();
        for (const column of parsed.columns) {
          seen.add(column);
          if (!scoped.has(column)) {
            violations.push(`${rel}: ${name}.${column} granted to ${role} — not in the client projection`);
          }
        }
        grantedColumns.set(name, seen);
      }
      continue;
    }
    if (/^ALL\b/i.test(parsed.privileges) && !NON_TABLE_OBJECT.test(parsed.objects)) {
      for (const name of objectNames(parsed.objects)) {
        if (!revokedAt.has(name)) revokedAt.set(name, index);
      }
    }
  }

  for (const table of tables) {
    if (!revokedAt.has(table.toLowerCase())) violations.push(`${rel}: ${table} not revoked from ${role}`);
  }

  for (const [table, scoped] of columnScoped) {
    const granted = grantedAt.get(table);
    if (granted === undefined) {
      violations.push(`${rel}: ${table} is never granted to ${role} — the client read path needs its columns`);
      continue;
    }
    const seen = grantedColumns.get(table) ?? new Set<string>();
    for (const column of scoped) {
      if (!seen.has(column)) violations.push(`${rel}: ${table}.${column} missing from the ${role} grant`);
    }
    const revoked = revokedAt.get(table);
    if (revoked === undefined) {
      violations.push(
        `${rel}: ${table} not revoked from ${role} before its column grant — an earlier table-wide grant would survive a re-run`,
      );
    } else if (revoked > granted) {
      violations.push(`${rel}: ${table} is revoked from ${role} AFTER its column grant — the grant is undone`);
    }
  }
  return violations;
}

/** Splits a comma-separated SQL list, ignoring commas inside parentheses or quotes. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (const ch of list) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "(") depth++;
    else if (!inSingle && !inDouble && ch === ")") depth--;
    if (ch === "," && depth === 0 && !inSingle && !inDouble) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The body of the LAST `CREATE VIEW "<view>" AS … ;` in `sql`, or null when there is none.
 *
 * LAST, not first: a view is redefined by whichever statement creates it last, so a rule that reads
 * the first one asserts a definition the database may have replaced. Wave B drops and recreates
 * `ClientVisibleComment`; scanning the migration history for the first match would read Wave A's.
 */
function lastViewDefinition(sql: string, view: string): string | null {
  // Same rewrite as `migrationDefiningView()`: a literal pattern captures the view name, and the body
  // is taken by SCANNING to the statement's `;` rather than with an unbounded lazy `([\s\S]*?)` inside
  // the pattern — CWE-185 and CWE-1333 on the old line (the build record). `indexOf(";")` is
  // exactly what the lazy group did: stop at the first `;` after `AS`. A statement with no `;` at all
  // did not match before and is skipped now, so a later definition still wins and a broken tail does
  // not overwrite a good body with null.
  let body: string | null = null;
  for (const m of sql.matchAll(/\bCREATE\s{1,40}(?:OR\s{1,40}REPLACE\s{1,40})?VIEW\s{1,40}"([A-Za-z0-9_]{1,80})"\s{1,40}AS/gi)) {
    if (m[1] !== view) continue;
    const at = m.index;
    if (at === undefined) continue;
    const end = sql.indexOf(";", at + m[0].length);
    if (end === -1) continue;
    body = sql.slice(at + m[0].length, end);
  }
  return body;
}

/**
 * The projection of the `ClientVisibleComment` view as bare column names, in written order. An aliased
 * or computed expression keeps its whole text, so it cannot masquerade as an allowlisted column.
 * Returns null when the view or its SELECT list is missing.
 */
function clientVisibleViewColumns(migrationSql: string): string[] | null {
  const view = lastViewDefinition(migrationSql, "ClientVisibleComment");
  if (view === null) return null;
  const select = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(view);
  if (!select) return null;
  return splitTopLevel(select[1]).map((expr) => {
    // Wave B's view has two expressions rather than bare columns — a CASE for `body` and a boolean for
    // `retracted` — so the alias is what names the column. An expression with NO alias still falls back
    // to its last dotted token, which is what keeps `c."authorKind"` reading as `authorKind` and what
    // makes an un-aliased computed column fail the allowlist comparison instead of passing it.
    const trimmed = expr.trim();
    const aliased = /^([\s\S]*?)\s+AS\s+"?([A-Za-z0-9_]+)"?$/i.exec(trimmed);
    if (aliased) {
      // A BARE column renamed with AS is exactly the masquerade this rule exists to catch
      // (`c."authorId" AS id`), so it keeps its whole text and fails the allowlist comparison. Only a
      // computed EXPRESSION may be named by its alias, because it has no column name of its own.
      const isBareColumn = /^[A-Za-z_][A-Za-z0-9_]*\.\s*"?[A-Za-z0-9_]+"?$/.test(aliased[1].trim());
      return isBareColumn ? trimmed : aliased[2];
    }
    return (trimmed.split(".").pop() ?? trimmed).replace(/"/g, "").trim();
  });
}

/**
 * The keys of an object literal in `code`, starting the search at `from` and taking the first `{`
 * after it. Nested keys (a relation select, which publicDb rejects anyway) are included deliberately:
 * they would surface as extra columns and fail the comparison, which is the safe direction. Null when
 * there is no literal there, so the caller fails loudly rather than comparing against nothing.
 */
function objectLiteralKeys(code: string, from: number): string[] | null {
  const open = code.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  return [...code.slice(open + 1, end).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]);
}

/**
 * The `"Ticket"` projection of `getClientTicketView` — the inline `select` on
 * `publicDb.ticket.findUnique` in client-view.ts, which the SQL column grant must match.
 */
function clientTicketSelectColumns(code: string): string[] | null {
  const call = /publicDb\.ticket\.findUnique\s*\(/.exec(code);
  if (!call) return null;
  const selectAt = code.indexOf("select:", call.index);
  if (selectAt === -1) return null;
  return objectLiteralKeys(code, selectAt);
}

/**
 * The client path's SECOND `"Ticket"` projection: the shared `CLIENT_TICKET_SELECT` literal that
 * `listClientTickets` (findMany) and `getClientTicketByNumber` (findFirst) read through.
 *
 * G15 used to parse only the findUnique select, so a column added to THIS literal alone was granted by
 * nobody and pinned by nothing — the by-id route would keep working while the list and by-number routes
 * failed at the privilege layer in the first environment with runtime roles. tsc catches the drift only
 * for columns the DTO builder consumes; this catches the rest. Decision #117 is the first change where
 * both projections are load-bearing for one feature, which is what surfaced the gap.
 */
function clientTicketSharedSelectColumns(code: string): string[] | null {
  const at = code.indexOf("const CLIENT_TICKET_SELECT");
  if (at === -1) return null;
  return objectLiteralKeys(code, at);
}

function isAppPage(rel: string): boolean {
  return rel.startsWith("src/app/(app)/") && rel.endsWith("/page.tsx");
}

// ---------------------------------------------------------------------------
// Audit-writer parsing
//
// G14's second half used to assert that a hard-coded list of action names appeared somewhere in
// src/types/domain.ts. That could not fail: every name on the list is a member of the `AuditAction`
// catalog the same file declares, tsc already pins that catalog to the Prisma enum, and a name sitting
// in a comment would have satisfied the substring check just as well. The list was also disconnected
// from the table lists next to it, so the edit the rule exists to catch — a later Wave adding a guarded
// state table whose transitions write no audit action — passed silently.
//
// Everything below reads the two sides the rule actually claims: the guarded tables come out of the
// migration's own triggers, and each declared action has to appear in an audit-entry literal inside a
// module that really persists rows (it calls writeAudit / writeAuditMany).
// ---------------------------------------------------------------------------

/** How the migration guards each table: `appendOnly` = BEFORE UPDATE OR DELETE, `state` = BEFORE DELETE. */
type TableGuards = { appendOnly: string[]; state: string[]; truncateGuarded: string[] };

const CREATE_TRIGGER_RE =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([A-Za-z0-9_]+)"?\s+BEFORE\s+(UPDATE\s+OR\s+DELETE|DELETE|TRUNCATE)\s+ON\s+(?:[A-Za-z0-9_"]+\.)?"?([A-Za-z0-9_]+)"?/i;
const DROP_TRIGGER_RE =
  /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+(?:[A-Za-z0-9_"]+\.)?"?([A-Za-z0-9_]+)"?/i;

/**
 * Classifies every table left carrying a guard trigger, by the trigger that guards it.
 *
 * Statement by statement, in written order, because the callers now hand this the WHOLE migration
 * history rather than one file: a trigger dropped and recreated (every migration here does that for
 * idempotence) nets out to guarded, and one dropped and NOT recreated nets out to unguarded — which a
 * text scan for `BEFORE DELETE ON "X"` would go on reporting as a guard forever. Comments are stripped
 * by `sqlStatements`, so a guard described in prose is not a guard either.
 */
function guardedTables(migrationSql: string): TableGuards {
  /** Surviving guard triggers, keyed table + trigger name, valued by the event they guard. */
  const live = new Map<string, { table: string; kind: string }>();
  for (const stmt of sqlStatements(migrationSql)) {
    const dropped = DROP_TRIGGER_RE.exec(stmt);
    if (dropped) {
      live.delete(`${dropped[2]}\u0000${dropped[1]}`);
      continue;
    }
    const created = CREATE_TRIGGER_RE.exec(stmt);
    if (!created) continue;
    live.set(`${created[3]}\u0000${created[1]}`, {
      table: created[3],
      kind: created[2].toUpperCase().replace(/\s+/g, " "),
    });
  }
  const appendOnly = new Set<string>();
  const state = new Set<string>();
  const truncateGuarded = new Set<string>();
  for (const { table, kind } of live.values()) {
    if (kind === "UPDATE OR DELETE") appendOnly.add(table);
    else if (kind === "DELETE") state.add(table);
    else truncateGuarded.add(table);
  }
  // An append-only table's DELETE is already covered by its UPDATE OR DELETE trigger; it is not a state table.
  for (const table of appendOnly) state.delete(table);
  const sorted = (s: Set<string>): string[] => [...s].sort();
  return { appendOnly: sorted(appendOnly), state: sorted(state), truncateGuarded: sorted(truncateGuarded) };
}

/** Tokens after which a `/` opens a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/**
 * When `code[at]` opens a regex literal, the index of its closing `/`; null when it is a division (or
 * an unterminated `/`). Comments are already stripped, so the only `/` left is one of the two.
 */
function regexLiteralEnd(code: string, at: number): number | null {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  const prev = j >= 0 ? code[j] : "";
  if (/[A-Za-z0-9_$)\]]/.test(prev)) {
    const word = /[A-Za-z0-9_$]+$/.exec(code.slice(0, j + 1))?.[0] ?? "";
    if (!REGEX_PRECEDING_KEYWORDS.has(word)) return null;
  }
  let inClass = false;
  for (let k = at + 1; k < code.length; k++) {
    const c = code[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "\n") return null; // an unterminated regex is not a regex
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return k;
  }
  return null;
}

/** One `{ action, entityType, fieldChanged, … }` literal as an audit writer spells it. */
type AuditEntryLiteral = { rel: string; action: string; entityType: string | null; fieldChanged: string | null };

/**
 * The OWN text of every object literal in `code`, in closing-brace order. Nested literals
 * (`metadata: { … }`) are removed from a literal's text, so a key is attributed to exactly one literal
 * and a nested object cannot lend its parent one. Strings, template literals and regex literals are
 * skipped, so neither `"action: \"X\""` inside a metadata note nor the `"` in a character class
 * (`/^[^\s@<>,;"]+@…/`, src/server/outbox.ts) can derail the scan.
 *
 * Extracted so `auditEntryLiterals` and `auditActionSites` read the same literals the same way: the two
 * differ only in what they accept as an `action`, and a brace-walker maintained twice would drift.
 */
function objectLiteralOwnTexts(code: string): string[] {
  const out: string[] = [];
  const stack: Array<{ start: number; children: Array<[number, number]> }> = [];
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/") {
      const end = regexLiteralEnd(code, i);
      if (end !== null) i = end;
      continue;
    }
    if (ch === "{") {
      stack.push({ start: i, children: [] });
      continue;
    }
    if (ch !== "}") continue;
    const frame = stack.pop();
    if (frame === undefined) continue;
    let own = "";
    let cursor = frame.start;
    for (const [childStart, childEnd] of frame.children) {
      own += code.slice(cursor, childStart);
      cursor = childEnd;
    }
    own += code.slice(cursor, i + 1);
    stack[stack.length - 1]?.children.push([frame.start, i + 1]);
    out.push(own);
  }
  return out;
}

/**
 * Every object literal in `file` that names an `action:` among its OWN keys, spelled as a string
 * literal — the strongest form, and the one G14 reads.
 *
 * A Prisma filter (`where: { action: "X", entityId }`) parses as a literal with no `entityType`, which
 * is what keeps it out of the G14 checks that need one.
 */
function auditEntryLiterals(file: Pick<SourceFile, "rel" | "code">): AuditEntryLiteral[] {
  const { rel } = file;
  const out: AuditEntryLiteral[] = [];
  for (const own of objectLiteralOwnTexts(file.code)) {
    const action = /(?:^|[{,\s])action:\s*"([A-Z0-9_]+)"/.exec(own);
    if (!action) continue;
    const entityType = /(?:^|[{,\s])entityType:\s*"([A-Z0-9_]+)"/.exec(own);
    const fieldChanged = /(?:^|[{,\s])fieldChanged:\s*"([A-Za-z0-9_]+)"/.exec(own);
    out.push({ rel, action: action[1], entityType: entityType?.[1] ?? null, fieldChanged: fieldChanged?.[1] ?? null });
  }
  return out;
}

/** One object literal that names an `action` key, however the value is spelled. */
type AuditActionSite = {
  rel: string;
  /**
   * The action names spelled as string literals in the `action:` value; BOTH arms of a ternary count
   * (`action: data.follow ? "TICKET_FOLLOWED" : "TICKET_UNFOLLOWED"`, src/server/notifications.actions.ts).
   * EMPTY when the value is computed (`action: verdict.action`, src/jobs/webhook-dispatch.ts) or a
   * shorthand over a parameter narrowed to a union of action literals (`{ action, entityType:
   * "TICKET_LINK" }`, src/server/ticket-links.actions.ts) — both of which are real audit writes.
   */
  actions: string[];
  entityType: string | null;
};

/**
 * `auditEntryLiterals` widened to the three other ways Wave B's writers spell an action. Refusing them
 * would make an audit rule fail on code that audits correctly, which is how a rule gets weakened to
 * nothing; admitting them without qualification would make it prove nothing. So the value is reported
 * rather than judged: `actions` empty means "this literal builds an audit entry of this entity type and
 * computes its action elsewhere", which is a fact G18 pairs with the module's own action literals.
 */
function auditActionSites(file: Pick<SourceFile, "rel" | "code">): AuditActionSite[] {
  const out: AuditActionSite[] = [];
  for (const own of objectLiteralOwnTexts(file.code)) {
    const key = /(?:^|[{,\s])action\s*(?::([^,}]*)|[,}])/.exec(own);
    if (!key) continue;
    const entityType = /(?:^|[{,\s])entityType:\s*"([A-Z0-9_]+)"/.exec(own);
    out.push({
      rel: file.rel,
      actions: [...(key[1] ?? "").matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]),
      entityType: entityType?.[1] ?? null,
    });
  }
  return out;
}

/**
 * Every SCREAMING_CASE double-quoted string in a module — how an action name reaches a helper that
 * builds the entry (`linkEntry(link, id, "TICKET_LINK_ADDED", n)`) or a verdict the entry copies.
 * Comments are already stripped, so a name that survives here is one the module actually says.
 */
function screamingStringLiterals(code: string): Set<string> {
  return new Set([...code.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1]));
}

/** The two roots that hold audit writers: server modules and the job bodies. */
const AUDIT_WRITER_ROOTS = ["src/server/", "src/jobs/"];

/** A module that actually persists audit rows — under a writer root, not a test, and calling the writer. */
function isAuditWriterModule(f: Pick<SourceFile, "rel" | "code">): boolean {
  if (!AUDIT_WRITER_ROOTS.some((root) => f.rel.startsWith(root))) return false;
  if (/\.test\.tsx?$/.test(f.rel)) return false;
  return /\bwriteAudit(?:Many)?\s*\(/.test(f.code);
}

/** The action names declared in src/types/domain.ts's `AuditAction` catalog, read as text. */
function auditCatalogActions(domainCode: string): string[] {
  const block = /export const AuditAction\s*=\s*\{([\s\S]*?)\n\}\s*as const;/.exec(domainCode);
  if (!block) return [];
  return [...block[1].matchAll(/(?:^|\n)\s*([A-Z0-9_]+)\s*:\s*"([A-Z0-9_]+)"\s*,/g)]
    .filter((m) => m[1] === m[2])
    .map((m) => m[2]);
}

// ---------------------------------------------------------------------------
// Scanner self-checks (so a regex regression cannot silently turn every rule vacuous)
// ---------------------------------------------------------------------------

describe("scanner", () => {
  it("finds the frozen contract files", () => {
    expect(byRel.has("src/types/domain.ts")).toBe(true);
    expect(byRel.has(SELF)).toBe(true);
  });

  it("parses static, type-only, mixed, namespace, side-effect, re-export and dynamic imports", () => {
    const code = [
      'import { PrismaClient } from "@prisma/client";',
      'import type { Prisma } from "@prisma/client";',
      'import { type A, type B as C } from "@/lib/db";',
      'import { type A, publicDb } from "@/lib/db";',
      'import Def, { named } from "../lib/audit";',
      'import * as ns from "next/server";',
      'import "./globals.css";',
      'export { x } from "@/server/tickets";',
      'export type { T } from "@/server/comments";',
      'const m = await import("@/lib/env");',
    ].join("\n");
    const refs = extractImports({ rel: "src/components/x.tsx", code });
    expect(refs.map((r) => [r.id, r.typeOnly, r.names.join("|")])).toEqual([
      ["@prisma/client", false, "PrismaClient"],
      ["@prisma/client", true, "Prisma"],
      ["@/lib/db", true, "A|B"],
      ["@/lib/db", false, "A|publicDb"],
      ["@/lib/audit", false, "default|named"],
      ["next/server", false, "*"],
      ["@/components/globals.css", false, ""],
      ["@/server/tickets", false, "x"],
      ["@/server/comments", true, "T"],
      ["@/lib/env", false, "*"],
    ]);
  });

  it("detects directives only as the first statement, not inside comments", () => {
    expect(hasDirective(stripComments('/** says "use server" */\n"use client";\nimport x from "y";'), "use client")).toBe(true);
    expect(hasDirective(stripComments('// "use client"\nimport x from "y";'), "use client")).toBe(false);
    expect(hasDirective(stripComments("'use server';\nexport async function a() {}"), "use server")).toBe(true);
    expect(hasDirective(stripComments('import x from "y";\n"use client";'), "use client")).toBe(false);
  });

  it("extracts Link tags across attribute expressions containing `>`", () => {
    const code = '<Link href={`/tickets/${id}`} onClick={() => a > b} prefetch={false}>\n  open\n</Link>\n<Link href="/dashboard">home</Link>';
    const tags = linkTags(code);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain("prefetch={false}");
    expect(tags[0]).not.toContain("open");
    expect(tags[1]).toBe('<Link href="/dashboard">');
  });

  it("splits SQL per statement and parses GRANT/REVOKE, including inside a DO block", () => {
    const sql = [
      "-- a comment; with a semicolon",
      'GRANT SELECT ON "Ticket", public."ClientVisibleComment" TO wm_helpdesk_public;',
      "DO $$",
      "BEGIN",
      "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wm_helpdesk_public') THEN",
      '    REVOKE ALL ON "Attachment", "SlaAlert" FROM wm_helpdesk_public;',
      "  END IF;",
      "END $$;",
    ].join("\n");
    const parsed = sqlStatements(sql)
      .map(parsePrivilegeStatement)
      .filter((p): p is NonNullable<typeof p> => p !== null);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].kind).toBe("GRANT");
    expect(parsed[0].roles).toEqual(["wm_helpdesk_public"]);
    expect(objectNames(parsed[0].objects)).toEqual(["ticket", "clientvisiblecomment"]);
    expect(parsed[1].kind).toBe("REVOKE");
    expect(parsed[1].privileges).toBe("ALL");
    expect(objectNames(parsed[1].objects)).toEqual(["attachment", "slaalert"]);
  });

  it("the client-role privilege scan fires on every way the public role could gain a read", () => {
    const tables = ["Attachment"];
    const readable = ["Ticket", "ClientVisibleComment"];
    const clean = [
      'GRANT SELECT ON "Ticket", "ClientVisibleComment" TO wm_helpdesk_public;',
      'GRANT CONNECT ON DATABASE :"dbname" TO wm_helpdesk_app, wm_helpdesk_public;',
      "GRANT USAGE ON SCHEMA public TO wm_helpdesk_app, wm_helpdesk_public;",
      'GRANT SELECT, INSERT, UPDATE ON "Attachment" TO wm_helpdesk_app;',
      'REVOKE ALL ON "Attachment" FROM wm_helpdesk_public;',
      "ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT ON TABLES TO wm_helpdesk_app;",
    ].join("\n");
    expect(clientRoleGrantViolations("x.sql", clean, tables, readable)).toEqual([]);

    for (const regression of [
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO wm_helpdesk_public;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT ON TABLES TO wm_helpdesk_public;",
      "GRANT wm_helpdesk_app TO wm_helpdesk_public;",
      'GRANT SELECT ON "Attachment" TO wm_helpdesk_public;',
      "GRANT SELECT ON attachment TO wm_helpdesk_public;",
      'GRANT SELECT ON public."Attachment" TO wm_helpdesk_public;',
      'GRANT SELECT ON "Attachment" TO wm_helpdesk_public, wm_helpdesk_app;',
      'GRANT SELECT ON "Attachment" TO wm_helpdesk_app, wm_helpdesk_public WITH GRANT OPTION;',
      'GRANT SELECT ON "User" TO wm_helpdesk_public;',
    ]) {
      expect(clientRoleGrantViolations("x.sql", `${clean}\n${regression}`, tables, readable), regression).not.toEqual(
        [],
      );
    }

    // The REVOKE half is anchored per statement: an `ALL` revoke aimed at another role cannot supply
    // the table name for a weaker revoke aimed at the public role (the file-wide match it replaced did).
    const spanning = [
      'REVOKE ALL ON "Comment" FROM wm_helpdesk_app;',
      'REVOKE SELECT ON "Attachment" FROM wm_helpdesk_public;',
    ].join("\n");
    expect(clientRoleGrantViolations("x.sql", spanning, tables, readable)).toEqual([
      "x.sql: Attachment not revoked from wm_helpdesk_public",
    ]);
  });

  it("parses column-scoped privilege lists apart from table-wide ones", () => {
    expect(parsePrivilegeColumns("ALL")).toEqual({ columns: null, tableWide: ["ALL"] });
    expect(parsePrivilegeColumns("SELECT, INSERT")).toEqual({ columns: null, tableWide: ["SELECT", "INSERT"] });
    expect(parsePrivilegeColumns('SELECT (id, "createdAt")')).toEqual({
      columns: ["id", "createdAt"],
      tableWide: [],
    });
    // A bare privilege sitting next to a column list still covers the whole table, and is reported.
    expect(parsePrivilegeColumns("SELECT, UPDATE (subject)")).toEqual({
      columns: ["subject"],
      tableWide: ["SELECT"],
    });
    const parsed = parsePrivilegeStatement(
      'GRANT SELECT (id, number, "requesterEmail") ON "Ticket" TO wm_helpdesk_public',
    );
    expect(parsed?.columns).toEqual(["id", "number", "requesterEmail"]);
    expect(objectNames(parsed?.objects ?? "")).toEqual(["ticket"]);
  });

  it("the column-scoped half of the client-role scan fires on every way a Ticket column could leak", () => {
    const tables: string[] = [];
    const readable = ["Ticket", "ClientVisibleComment"];
    const columns = ["id", "subject", "requesterEmail"];
    const opts = { columnScoped: { Ticket: columns } };
    const grant = 'GRANT SELECT (id, subject, "requesterEmail") ON "Ticket" TO wm_helpdesk_public;';
    const clean = ['REVOKE ALL ON "Ticket" FROM wm_helpdesk_public;', grant].join("\n");
    expect(clientRoleGrantViolations("x.sql", clean, tables, readable, opts)).toEqual([]);

    for (const [label, sql] of [
      // The regression this rule exists for: the whole table, which carries every future column.
      [
        "table-wide grant",
        [
          'REVOKE ALL ON "Ticket" FROM wm_helpdesk_public;',
          'GRANT SELECT ON "Ticket" TO wm_helpdesk_public;',
        ].join("\n"),
      ],
      // A column nobody asked for, added to the list.
      ["extra column", clean.replace('"requesterEmail"', '"requesterEmail", "requesterPhone"')],
      // No REVOKE first: an older table-wide grant survives the re-run untouched.
      ["no revoke before the grant", grant],
      // REVOKE after the GRANT undoes it.
      ["revoke after the grant", [grant, 'REVOKE ALL ON "Ticket" FROM wm_helpdesk_public;'].join("\n")],
      // Never granted at all: the client read path would 500, and the allowlist would be vacuous.
      ["no grant at all", 'REVOKE ALL ON "Ticket" FROM wm_helpdesk_public;'],
      // A table-wide privilege riding along beside the column list.
      ["table-wide privilege beside the list", clean.replace("GRANT SELECT (", "GRANT SELECT, SELECT (")],
    ] as const) {
      expect(clientRoleGrantViolations("x.sql", sql, tables, readable, opts), label).not.toEqual([]);
    }

    // A missing column is a violation too — the allowlist is an equality, not a ceiling.
    expect(
      clientRoleGrantViolations("x.sql", clean, tables, readable, {
        columnScoped: { Ticket: [...columns, "resolvedAt"] },
      }),
    ).toEqual(["x.sql: ticket.resolvedAt missing from the wm_helpdesk_public grant"]);
  });

  it("reads getClientTicketView's Ticket projection from the source", () => {
    const code = [
      "const t = await publicDb.ticket.findUnique({",
      "  where: { id: ticketId },",
      "  select: {",
      "    id: true,",
      "    number: true,",
      "    requesterEmail: true,",
      "  },",
      "});",
    ].join("\n");
    expect(clientTicketSelectColumns(code)).toEqual(["id", "number", "requesterEmail"]);
    // A widened projection is visible, whatever it is called.
    expect(clientTicketSelectColumns(code.replace("number: true,", "number: true,\n    householdId: true,"))).toContain(
      "householdId",
    );
    expect(clientTicketSelectColumns("const t = await publicDb.ticket.findMany({});")).toBeNull();
  });

  it("reads the client-visible view's projection by column, whatever the spelling", () => {
    const view = (select: string) =>
      `DROP VIEW IF EXISTS "ClientVisibleComment";\nCREATE VIEW "ClientVisibleComment" AS\n  SELECT ${select}\n  FROM "Comment" c\n  WHERE c.visibility = 'PUBLIC';`;
    expect(clientVisibleViewColumns(view('c.id, c."ticketId", c."authorKind"'))).toEqual([
      "id",
      "ticketId",
      "authorKind",
    ]);
    // The spelling a real edit would use, which a `c.macroId` substring check cannot see.
    expect(clientVisibleViewColumns(view('c.id, c."macroId"'))).toContain("macroId");
    // Last position, no trailing comma — the other shape the old substring check missed.
    expect(clientVisibleViewColumns(view("c.id, c.visibility"))).toContain("visibility");
    // An alias cannot masquerade as an allowlisted column.
    expect(clientVisibleViewColumns(view('c."authorId" AS id'))).not.toEqual(["id"]);
    expect(clientVisibleViewColumns('SELECT 1 FROM "Comment";')).toBeNull();

    // The whole point of scanning the migration HISTORY: the view is whatever the last CREATE says it
    // is. Reading the first definition is how G16 would go on asserting a shape the database replaced.
    const rebuilt = `${view("c.id, c.visibility")}\n${view('c.id, c."ticketId"')}`;
    expect(clientVisibleViewColumns(rebuilt)).toEqual(["id", "ticketId"]);
    expect(lastViewDefinition(rebuilt, "ClientVisibleComment")).toContain('c."ticketId"');
    expect(lastViewDefinition(rebuilt, "NoSuchView")).toBeNull();
    // `CREATE OR REPLACE` is a redefinition too.
    expect(
      clientVisibleViewColumns(
        `${view("c.id, c.visibility")}\nCREATE OR REPLACE VIEW "ClientVisibleComment" AS SELECT c.id FROM "Comment" c;`,
      ),
    ).toEqual(["id"]);
  });

  it("reads the table universe out of prisma/schema.prisma, so a new model cannot pass G17/G18 by silence", () => {
    const schema = [
      "model Ticket {",
      "  id String @id",
      "}",
      "",
      "model Newcomer {",
      '  id String @id /// model Decoy { not a model',
      "}",
      "",
      "model Renamed {",
      "  id String @id",
      '  @@map("physical_name")',
      "}",
    ].join("\n");
    expect(prismaModels(schema)).toEqual(["Ticket", "Newcomer", "physical_name"]);

    // The real schema, against the two lists the rules partition it into. This is the assertion that
    // makes "fails by omission" true: a fourteenth model lands in WAVE_B_TABLES with no edit here.
    expect(PRISMA_MODELS.length).toBeGreaterThan(WAVE_B_TABLES.length);
    expect(WAVE_B_TABLES).toContain("FollowUpNudge");
    expect(WAVE_B_TABLES).not.toContain("Ticket");
    expect(PRE_WAVE_B_TABLES.filter((t) => WAVE_B_TABLES.includes(t))).toEqual([]);
    expect([...PRE_WAVE_B_TABLES, ...WAVE_B_TABLES].sort()).toEqual([...PRISMA_MODELS].sort());
  });

  it("scans every migration in creation order, so a later one cannot land outside the DB guardrails", () => {
    const folders = migrationFolders();
    expect(folders.length, "no migration folders found").toBeGreaterThan(0);
    expect([...folders].sort()).toEqual(folders);
    const sources = migrationSources();
    expect(sources.map((m) => m.rel)).toEqual(folders.map((f) => `prisma/migrations/${f}/migration.sql`));
    // Every folder's SQL is in the concatenation, so no statement is outside the scan.
    const all = allMigrationSql();
    for (const { rel, sql } of sources) expect(all, `${rel} is missing from the scan`).toContain(sql.trim());
    // And the view rule lands on a real migration rather than a constant.
    const defining = migrationDefiningView("ClientVisibleComment");
    expect(defining?.rel).toBe(sources.filter((m) => m.sql.includes('CREATE VIEW "ClientVisibleComment"')).pop()?.rel);
  });

  it("classifies the migration's guard triggers by table, so a newly guarded table is visible to G14", () => {
    const sql = [
      'DROP TRIGGER IF EXISTS ledger_no_update_delete ON "Ledger";',
      'CREATE TRIGGER ledger_no_update_delete',
      '  BEFORE UPDATE OR DELETE ON "Ledger"',
      "  FOR EACH ROW EXECUTE FUNCTION wm_no_update_delete();",
      'CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON "Ledger" FOR EACH STATEMENT EXECUTE FUNCTION wm_no_truncate();',
      'CREATE TRIGGER held_no_delete BEFORE DELETE ON "Held" FOR EACH ROW EXECUTE FUNCTION wm_no_delete();',
    ].join("\n");
    expect(guardedTables(sql)).toEqual({ appendOnly: ["Ledger"], state: ["Held"], truncateGuarded: ["Ledger"] });
    // The edit G14 exists to catch: a sixth guarded table lands and must be declared somewhere.
    const widened = `${sql}\nCREATE TRIGGER newcomer_no_delete BEFORE DELETE ON "Newcomer" FOR EACH ROW EXECUTE FUNCTION wm_no_delete();`;
    expect(guardedTables(widened).state).toEqual(["Held", "Newcomer"]);

    // Scanning the whole history means a later migration can REMOVE a guard, and the rules have to see
    // that. A drop with no recreate leaves the table unguarded; the text scan this replaced would have
    // gone on reporting the original CREATE as a live guard.
    const removed = `${sql}\nDROP TRIGGER held_no_delete ON "Held";`;
    expect(guardedTables(removed).state).toEqual([]);
    expect(guardedTables(removed).appendOnly).toEqual(["Ledger"]);
    // A guard added by a LATER file counts, exactly as the concatenation presents it.
    const later = `${sql}\nCREATE TRIGGER newcomer_no_truncate BEFORE TRUNCATE ON "Newcomer" FOR EACH STATEMENT EXECUTE FUNCTION wm_no_truncate();`;
    expect(guardedTables(later).truncateGuarded).toEqual(["Ledger", "Newcomer"]);
    // Prose is not a guard: `sqlStatements` strips comments before any of this is read.
    expect(guardedTables('-- CREATE TRIGGER x BEFORE DELETE ON "Imaginary" ...\n').state).toEqual([]);
  });

  it("reads audit-entry literals without letting a nested object, a string or a Prisma filter masquerade as one", () => {
    const code = [
      "await writeAuditMany(tx, actor, ctx, [",
      "  {",
      '    action: "MESSAGE_SENT",',
      '    entityType: "MESSAGE_DELIVERY",',
      '    fieldChanged: "status",',
      '    metadata: { note: "action: \\"MESSAGE_FAILED\\"", nested: { deep: true } },',
      "  },",
      "]);",
      'const rows = await tx.auditLog.findMany({ where: { action: "MESSAGE_SENT", entityId: id } });',
    ].join("\n");
    expect(auditEntryLiterals({ rel: "src/server/x.ts", code })).toEqual([
      { rel: "src/server/x.ts", action: "MESSAGE_SENT", entityType: "MESSAGE_DELIVERY", fieldChanged: "status" },
      // The Prisma filter parses, but with no entityType it can never satisfy a G14 writer check.
      { rel: "src/server/x.ts", action: "MESSAGE_SENT", entityType: null, fieldChanged: null },
    ]);
    // A regex literal carrying a quote in a character class (the deliverable-address check in
    // src/server/outbox.ts) used to swallow the rest of the file as a string; a division does not.
    const withRegex = [
      'const DELIVERABLE = /^[^\\s@<>,;"]+@[A-Za-z0-9-]+$/;',
      "const ratio = attempts / cap;",
      'entries.push({ action: "MESSAGE_FAILED", entityType: "MESSAGE_DELIVERY", fieldChanged: "status" });',
    ].join("\n");
    expect(auditEntryLiterals({ rel: "src/server/z.ts", code: withRegex })).toEqual([
      { rel: "src/server/z.ts", action: "MESSAGE_FAILED", entityType: "MESSAGE_DELIVERY", fieldChanged: "status" },
    ]);

    // `as const` on the values and an entry built inside a .map() callback are both real spellings.
    const mapped = 'planned.map((p) => ({ action: "ATTACHMENT_ADDED" as const, entityType: "ATTACHMENT" as const, fieldChanged: "state" }));';
    expect(auditEntryLiterals({ rel: "src/server/y.ts", code: mapped })).toEqual([
      { rel: "src/server/y.ts", action: "ATTACHMENT_ADDED", entityType: "ATTACHMENT", fieldChanged: "state" },
    ]);
  });

  it("reads an audit entry's action when it is a ternary, a shorthand or a computed value, without inventing one", () => {
    // The three spellings G18's audited half has to accept. A literal action is still reported as a
    // literal; the other two report NO action, which is what makes the fallback in G18 a narrow,
    // entity-type-scoped step rather than "the module mentions the name somewhere".
    const ternary =
      'await writeAuditMany(tx, actor, ctx, [{ action: data.follow ? "TICKET_FOLLOWED" : "TICKET_UNFOLLOWED", entityType: "TICKET", fieldChanged: "follower" }]);';
    expect(auditActionSites({ rel: "src/server/n.ts", code: ternary })).toEqual([
      { rel: "src/server/n.ts", actions: ["TICKET_FOLLOWED", "TICKET_UNFOLLOWED"], entityType: "TICKET" },
    ]);
    const shorthand = 'function linkEntry(action) { return { action, entityType: "TICKET_LINK", fieldChanged: "kind" }; }';
    expect(auditActionSites({ rel: "src/server/l.ts", code: shorthand })).toEqual([
      { rel: "src/server/l.ts", actions: [], entityType: "TICKET_LINK" },
    ]);
    const computed = 'const entry = { action: verdict.action, entityType: "WEBHOOK_DELIVERY", fieldChanged: "status" };';
    expect(auditActionSites({ rel: "src/jobs/w.ts", code: computed })).toEqual([
      { rel: "src/jobs/w.ts", actions: [], entityType: "WEBHOOK_DELIVERY" },
    ]);
    // A metadata note is a nested literal, so it cannot lend its parent an action, and a key that
    // merely ends in "action" is not the action key.
    const noise = 'const x = { bulkAction: "TICKET_MERGED", metadata: { action: "TICKET_VOIDED" }, entityType: "TICKET" };';
    expect(auditActionSites({ rel: "src/server/x.ts", code: noise })).toEqual([
      { rel: "src/server/x.ts", actions: ["TICKET_VOIDED"], entityType: null },
    ]);
    // Refactoring the brace-walk out must not change what G14 reads.
    expect(auditEntryLiterals({ rel: "src/server/n.ts", code: ternary })).toEqual([]);
    expect(auditEntryLiterals({ rel: "src/server/l.ts", code: shorthand })).toEqual([]);
  });

  it("collects the SCREAMING_CASE literals a module says, and only those", () => {
    const code = 'linkEntry(link, id, "TICKET_LINK_ADDED", n); const k = "kind"; const t = `TICKET_MERGED`;';
    const names = screamingStringLiterals(stripComments(code));
    expect(names.has("TICKET_LINK_ADDED")).toBe(true);
    // A lower-case value is not an action name, and a template literal is not a double-quoted string.
    expect(names.has("kind")).toBe(false);
    expect(names.has("TICKET_MERGED")).toBe(false);
    // A name that appears only in a comment is not something the module says.
    expect(screamingStringLiterals(stripComments('// see "TICKET_VOIDED"\nconst a = 1;')).has("TICKET_VOIDED")).toBe(false);
  });

  it("counts a module as an audit writer only when it is a non-test module under src/server/** or src/jobs/** that writes rows", () => {
    const writes = "await writeAuditMany(tx, actor, ctx, entries);";
    expect(isAuditWriterModule({ rel: "src/server/outbox.ts", code: writes })).toBe(true);
    expect(isAuditWriterModule({ rel: "src/jobs/sla-sweep.ts", code: "await writeAudit(tx, actor, ctx, entry);" })).toBe(true);
    // A test asserting on rows is not a writer, and neither is a module that only names the function.
    expect(isAuditWriterModule({ rel: "src/server/outbox.integration.test.ts", code: writes })).toBe(false);
    expect(isAuditWriterModule({ rel: "src/server/suspended-intake.ts", code: 'const a = "writeAuditMany";' })).toBe(false);
    expect(isAuditWriterModule({ rel: "src/app/api/x/route.ts", code: writes })).toBe(false);
  });

  it("reads the AuditAction catalog as declared names, not as prose", () => {
    const domain = [
      "export const AuditAction = {",
      '  TICKET_CREATED: "TICKET_CREATED",',
      '  MESSAGE_LEASED: "MESSAGE_LEASED",',
      "} as const;",
      "export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];",
    ].join("\n");
    expect(auditCatalogActions(domain)).toEqual(["TICKET_CREATED", "MESSAGE_LEASED"]);
    // A name that appears only in a comment is not in the catalog.
    expect(auditCatalogActions(stripComments(domain.replace('  MESSAGE_LEASED: "MESSAGE_LEASED",', "  // MESSAGE_LEASED")))).toEqual([
      "TICKET_CREATED",
    ]);
    expect(auditCatalogActions("export const Other = { A: \"A\" } as const;")).toEqual([]);
  });

  it("strips comments but keeps URLs", () => {
    const code = stripComments('const u = "https://x.test/a"; // trailing\n// whole line @/lib/db\n/* block\n auditLog.update */\nconst v = 1;');
    expect(code).toContain('"https://x.test/a"');
    expect(code).not.toContain("trailing");
    expect(code).not.toContain("@/lib/db");
    expect(code).not.toContain("auditLog.update");
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe("guardrails (static scan over src/**)", () => {
  it("G1 — client files and src/components/** never import node-only modules, non-action server modules, Prisma values or other @/app modules", () => {
    const violations: string[] = [];
    for (const f of SOURCES) {
      const isClient = hasDirective(f.code, "use client") || f.rel.startsWith("src/components/");
      if (!isClient) continue;
      for (const ref of extractImports(f)) {
        if (ref.typeOnly) continue;
        const serverRead = SERVER_COMPONENT_MOUNT_POINTS.includes(f.rel) && isNonActionsServerModule(ref.id);
        if (!serverRead && (CLIENT_FORBIDDEN_MODULES.includes(ref.id) || isNonActionsServerModule(ref.id))) {
          violations.push(`${f.rel}: imports ${ref.specifier}`);
        }
        if (isPrismaValueImport(ref)) violations.push(`${f.rel}: value-imports ${ref.specifier}`);
        if (ref.id.startsWith("@/app/") && ref.id !== "@/app/sign-in/sign-in.actions" && !ref.id.endsWith(".css")) {
          violations.push(`${f.rel}: imports app module ${ref.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("G1b — the server-component mount-point allowlist names only files that exist and carry no client directive", () => {
    const problems: string[] = [];
    for (const rel of SERVER_COMPONENT_MOUNT_POINTS) {
      const file = byRel.get(rel);
      if (!file) {
        problems.push(`${rel}: allowlisted but absent — remove it from SERVER_COMPONENT_MOUNT_POINTS`);
        continue;
      }
      if (hasDirective(file.code, "use client")) {
        problems.push(`${rel}: allowlisted as a server component but carries "use client"`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("G2 — middleware, auth.config and every L1 module import nothing from L2+, no Prisma values, no next/headers, no node:*", () => {
    const violations: string[] = [];
    const targets = ["src/middleware.ts", "src/auth.config.ts", ...L1_MODULES];
    for (const rel of targets) {
      const f = byRel.get(rel);
      if (!f) continue;
      const isL1 = L1_MODULES.includes(rel);
      for (const ref of extractImports(f)) {
        if (ref.typeOnly) continue;
        if (isL2Plus(ref.id) || (isL1 && (ref.id === "@/auth.config" || ref.id === "@/middleware"))) {
          violations.push(`${rel}: imports ${ref.specifier}`);
        }
        if (isPrismaValueImport(ref)) violations.push(`${rel}: value-imports ${ref.specifier}`);
        if (ref.specifier === "next/headers") violations.push(`${rel}: imports next/headers`);
        if (isNodeBuiltin(ref.specifier)) violations.push(`${rel}: imports node builtin ${ref.specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("G3 — every src/app/api/**/route.ts except the Auth.js handler and the health probe authenticates its caller", () => {
    // Wave A amended this rule ONCE, by adding a third authenticator — not by adding exemptions.
    // `isIntegrationApiAuthorized(` is the machine bearer (src/lib/integration-auth.ts) used by
    // /api/ingest/**, /api/export/** and /api/integrations/**, which sit outside the session
    // middleware exactly as /api/client does. The exemption list is still two files, and both are
    // pinned by name above. A route that authenticates by none of the three fails here.
    // Wave B amends this rule a SECOND time, again by adding authenticators rather than exemptions.
    // `verifyApiToken(` is the per-consumer database credential (src/lib/api-tokens.ts) used by
    // /api/mcp; `authorizeClientApiRequest(` is the client-API pair (a ClientApiToken with scope
    // CLIENT_READ, else the legacy CLIENT_API_TOKEN bearer) used by the two Wave B client routes.
    // `authorizeMachineRequest(` is the same pair for the six machine routes (a ClientApiToken with
    // the route's INTEGRATION_*/EXPORT_READ scope, else the legacy INTEGRATION_API_TOKEN bearer).
    // The exemption list is still two files, and both are still pinned by name above.
    const AUTHENTICATORS = [
      "requireViewerOrThrow(",
      "isClientApiAuthorized(",
      "isIntegrationApiAuthorized(",
      "verifyApiToken(",
      "authorizeClientApiRequest(",
      "authorizeMachineRequest(",
    ];
    const violations: string[] = [];
    for (const f of SOURCES) {
      if (!isApiRoute(f.rel) || f.rel === AUTH_ROUTE || f.rel === HEALTH_ROUTE) continue;
      if (!AUTHENTICATORS.some((needle) => f.code.includes(needle))) violations.push(f.rel);
    }
    expect(violations).toEqual([]);
  });

  it("G3b — the machine-bearer routes live only under the three middleware-excluded prefixes, and nothing else uses that bearer", () => {
    // The middleware matcher excludes /api/ingest, /api/export and /api/integrations (src/middleware.ts).
    // A route that authenticates with the integration bearer but sits INSIDE the matcher would be
    // unreachable by a machine (redirected to /sign-in); a route OUTSIDE those prefixes that used the
    // bearer would be an unguarded hole the matcher no longer covers. Both directions fail here.
    const MACHINE_PREFIXES = ["src/app/api/ingest/", "src/app/api/export/", "src/app/api/integrations/"];
    // the six machine routes now call `authorizeMachineRequest(`, which tries a
    // `ClientApiToken` carrying the surface's scope and FALLS BACK to `isIntegrationApiAuthorized(`.
    // Both spellings are the machine bearer path, so both count here — and the second direction of
    // this rule (a machine authenticator outside the three excluded prefixes) still fails on either.
    // The two Wave B client-facing authenticators are deliberately NOT in this list: `/api/mcp` and
    // `/api/client/**` sit outside these prefixes and authenticate by their own mechanisms.
    const MACHINE_AUTHENTICATORS = ["isIntegrationApiAuthorized(", "authorizeMachineRequest("];
    const violations: string[] = [];
    for (const f of SOURCES) {
      if (!isApiRoute(f.rel)) continue;
      const underMachinePrefix = MACHINE_PREFIXES.some((prefix) => f.rel.startsWith(prefix));
      const usesMachineBearer = MACHINE_AUTHENTICATORS.some((needle) => f.code.includes(needle));
      if (underMachinePrefix && !usesMachineBearer) violations.push(`${f.rel}: machine route without the bearer check`);
      if (!underMachinePrefix && usesMachineBearer) violations.push(`${f.rel}: machine bearer outside the excluded prefixes`);
    }
    expect(violations).toEqual([]);

    const middleware = byRel.get("src/middleware.ts");
    expect(middleware, "src/middleware.ts missing").toBeDefined();
    if (!middleware) return;
    for (const prefix of ["api/ingest", "api/export", "api/integrations", "api/client", "api/auth", "api/health"]) {
      expect(middleware.code, `matcher must exclude ${prefix}`).toContain(prefix);
    }
    // The attachment download is a STAFF surface: it stays behind the session gate.
    expect(middleware.code).not.toContain("api/attachments");
  });

  it("G3c — every middleware matcher exclusion is anchored to a path-segment boundary, so near-miss route names stay gated", () => {
    // G3b proves the matcher NAMES the six sessionless prefixes; it cannot see where each one ends.
    // A bare prefix inside the negative lookahead excludes every path that merely STARTS with it, so
    // `api/client` would also un-gate `/api/clients/...` and `api/health` would un-gate `/api/healthz`.
    // The next route added under a near-miss name would then be served with no session middleware and
    // a green suite. Each exclusion must end at a segment boundary — `(?:/|$)`, or a bare `$` for a
    // single file such as favicon.ico and for the static-asset extensions.
    const middleware = byRel.get("src/middleware.ts");
    expect(middleware, "src/middleware.ts missing").toBeDefined();
    if (!middleware) return;

    const literal = middleware.text.match(/matcher:\s*\[\s*("(?:[^"\\]|\\.)*")/);
    expect(literal, "could not read the matcher literal out of src/middleware.ts").not.toBeNull();
    if (!literal) return;
    const matcher = JSON.parse(literal[1]) as string;
    // path-to-regexp compiles a matcher of this shape into a whole-pathname match. That compiled form
    // is written out as a LITERAL below rather than assembled from `matcher` at run time, because a
    // pattern built from a non-literal is a security scanner CWE-185/CWE-1333 finding. Nothing is lost and nothing
    // can drift: the assertion that follows fails the moment src/middleware.ts changes its matcher,
    // so the cases below are still evaluated against the shipped value.
    const GATED =
      /^\/((?!api\/auth(?:\/|$)|api\/client(?:\/|$)|api\/health(?:\/|$)|api\/ingest(?:\/|$)|api\/export(?:\/|$)|api\/integrations(?:\/|$)|api\/mcp(?:\/|$)|_next\/static(?:\/|$)|_next\/image(?:\/|$)|favicon\.ico$|manifest\.webmanifest$|sw\.js$|offline\.html$|sign-in(?:\/|$)|no-access(?:\/|$)|.*\.(?:png|svg|ico|jpg|jpeg|webp)$).*)$/;
    // `.source` keeps the `\/` escapes a regex literal requires; the matcher string has bare slashes.
    expect(
      GATED.source.replaceAll("\\/", "/"),
      "src/middleware.ts changed its matcher — update GATED in this test to the new anchored form",
    ).toBe(`^${matcher}$`);
    const gated = (pathname: string): boolean => GATED.test(pathname);

    // The seven surfaces authenticated by something other than the session, plus the asset paths, stay OUT.
    for (const open of [
      "/api/auth/callback/okta",
      "/api/client/tickets/abc",
      "/api/health",
      "/api/ingest/email",
      "/api/export/tickets",
      "/api/integrations/outbox/lease",
      // Slice B8. `/api/mcp` authenticates on a `ClientApiToken` bearer carrying scope MCP and nothing
      // else; a 307 to /sign-in is unfollowable by an agent runtime, which would read the HTML sign-in
      // page as a protocol response. See the header of src/app/api/mcp/route.ts.
      "/api/mcp",
      "/_next/static/chunk.js",
      "/_next/image",
      "/favicon.ico",
      "/sign-in",
      "/no-access",
      "/logo.svg",
      "/icons/icon-192.png",
      // Slice B10. A browser fetches all three outside any session: the manifest uncredentialed, the
      // service worker as JavaScript (`register` rejects an HTML redirect), and the offline page from
      // the SW cache. Gated, the manifest logs a JSON syntax error on every page load and the whole
      // PWA slice is inert. None of the three carries client material.
      "/manifest.webmanifest",
      "/sw.js",
      "/offline.html",
    ]) {
      expect(gated(open), `${open} must be excluded from the session middleware`).toBe(false);
    }

    // ...and every near-miss neighbour is STILL gated. This is the fencepost the anchoring fixes.
    for (const closed of [
      "/api/clients/x",
      "/api/client-portal/x",
      "/api/healthz",
      "/api/exports/x",
      "/api/integrationsettings",
      "/api/ingest-status",
      "/api/authz",
      "/api/mcps",
      "/api/mcp-admin",
      "/api/attachments/abc",
      "/sign-in-help",
      "/no-access-report",
      "/_next/staticfiles",
      "/dashboard",
      "/tickets/abc",
      // The PWA exclusions are whole-path, not prefixes: a nested or extended near-miss stays gated.
      "/manifest.webmanifest/x",
      "/tickets/sw.js",
      "/offline.html.bak",
      "/api/sw.js",
    ]) {
      expect(gated(closed), `${closed} must stay behind the session middleware`).toBe(true);
    }
  });

  it("G4 — every src/server/*.actions.ts wraps each export in runAction; \"use server\" files are *.actions.ts and live in src/server/ (sign-in.actions.ts is the only exception)", () => {
    const violations: string[] = [];
    for (const f of SOURCES) {
      const isServerActions = /^src\/server\/[^/]+\.actions\.ts$/.test(f.rel);
      if (isServerActions) {
        const exports = (f.code.match(/\bexport\s+async\s+function\b/g) ?? []).length;
        const wrapped = (f.code.match(/\brunAction\b\s*(?:<[^()]*?>)?\s*\(/g) ?? []).length;
        if (exports !== wrapped) violations.push(`${f.rel}: ${exports} exported async functions vs ${wrapped} runAction( calls`);
        if (!hasDirective(f.code, "use server")) violations.push(`${f.rel}: missing "use server" directive`);
      }
      if (hasDirective(f.code, "use server")) {
        if (!f.rel.endsWith(".actions.ts")) violations.push(`${f.rel}: "use server" file must be named *.actions.ts`);
        if (!f.rel.startsWith("src/server/") && f.rel !== SIGN_IN_ACTIONS) {
          violations.push(`${f.rel}: "use server" file outside src/server/`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("G5 — no auditLog/comment update-or-delete and no ticket delete outside src/lib/db.ts and its tests", () => {
    const forbidden = [
      /\bauditLog\.(update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/g,
      /\bcomment\.(update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/g,
      /\bticket\.(delete|deleteMany)\b/g,
    ];
    const violations: string[] = [];
    for (const f of SOURCES) {
      if (f.rel === "src/lib/db.ts" || /^src\/lib\/db.*\.test\.ts$/.test(f.rel) || f.rel === SELF) continue;
      for (const re of forbidden) {
        for (const m of f.code.matchAll(re)) violations.push(`${f.rel}: ${m[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("G6 — every <Link> whose href contains /tickets/ sets prefetch={false} in the same tag (I11)", () => {
    const violations: string[] = [];
    for (const f of SOURCES) {
      if (!f.rel.endsWith(".tsx")) continue;
      for (const tag of linkTags(f.code)) {
        if (!tag.includes("/tickets/")) continue;
        if (!/\bprefetch\s*=\s*\{\s*false\s*\}/.test(tag)) violations.push(`${f.rel}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("G7 — the client API route imports only @/server/client-view, @/lib/request-context and next/server (I1)", () => {
    const f = byRel.get(CLIENT_ROUTE);
    if (!f) return; // S3 not landed yet — vacuous
    const allowed = new Set(["@/server/client-view", "@/lib/request-context", "next/server"]);
    const violations = extractImports(f)
      .filter((ref) => !ref.typeOnly && !allowed.has(ref.id))
      .map((ref) => ref.specifier);
    expect(violations).toEqual([]);
  });

  it("G8 — src/server/client-view.ts reads through publicDb + the view only and never touches internal-note paths (I1)", () => {
    const f = byRel.get(CLIENT_VIEW);
    if (!f) return; // S3 not landed yet — vacuous
    const violations: string[] = [];
    for (const ref of extractImports(f)) {
      if (ref.id === "@/server/tickets" || ref.id === "@/server/comments") violations.push(`imports ${ref.specifier}`);
      if (ref.typeOnly) continue;
      if (ref.id === "@/lib/db") {
        if (ref.namespace) violations.push("namespace import of @/lib/db");
        for (const n of ref.names) if (n !== "publicDb") violations.push(`imports ${n} from @/lib/db`);
      }
      if (ref.id === "@/lib/audit") {
        if (ref.namespace) violations.push("namespace import of @/lib/audit");
        for (const n of ref.names) {
          if (n !== "recordClientApiRead" && n !== "recordClientApiDenied") violations.push(`imports ${n} from @/lib/audit`);
        }
      }
    }
    if (!f.text.includes('"ClientVisibleComment"')) violations.push('does not reference "ClientVisibleComment"');
    for (const needle of ["include:", "$executeRaw", "$queryRawUnsafe", "prisma.", "comments:", "auditLogs:", "queue:", "createdBy:", "assignee:"]) {
      if (f.code.includes(needle)) violations.push(`contains ${needle}`);
    }
    expect(violations).toEqual([]);
  });

  it("G9 — every (app) page and every API route (Auth.js handler and health probe included) exports dynamic = \"force-dynamic\"", () => {
    const violations: string[] = [];
    let scannedRoutes = 0;
    for (const f of SOURCES) {
      if (!isAppPage(f.rel) && !isApiRoute(f.rel)) continue;
      if (isApiRoute(f.rel)) scannedRoutes++;
      if (!/\bexport\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(f.code)) violations.push(f.rel);
    }
    expect(violations).toEqual([]);
    // The two G3-exempt routes are NOT exempt here: both are scanned (the health probe must never be statically cached).
    expect(SOURCES.filter((f) => f.rel === AUTH_ROUTE || f.rel === HEALTH_ROUTE).length).toBeLessThanOrEqual(scannedRoutes);
  });

  it("G19 — a route.ts exports only its HTTP handlers and the route-segment config (integration round 3)", () => {
    // WHY THIS RULE EXISTS, and why it is worth a guardrail rather than a code comment.
    //
    // Next.js validates a route handler's module shape with types it GENERATES during `next build`.
    // `npx tsc --noEmit` does not see them, and no unit test imports a route the way the framework
    // does, so an ordinary-looking `export const` in a `route.ts` type-checks, lints, passes the whole
    // suite — and then fails the build with:
    //
    //   Type error: Route "src/app/api/tickets/[id]/presence/route.ts" does not match the required
    //   types of a Next.js Route.  "PRESENCE_DENIAL_WINDOW_MS" is not a valid Route export field.
    //
    // That is exactly what happened: the presence route exported its denial window so its own test
    // could read it. The constant now lives in `@/lib/denial-throttle` beside `DENIAL_WINDOW_MS`, and
    // this rule is here so the next one fails in the suite — seconds — instead of at the end of a
    // build. A shared constant belongs in a module both the route and its test can import; a route
    // file is a framework entry point, not a library.
    //
    // The allowed set is Next 15's, spelled out rather than inferred: the seven method handlers, the
    // seven route-segment config fields, and `generateStaticParams`. `default` is not in it.
    const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
    const SEGMENT_CONFIG = [
      "dynamic",
      "dynamicParams",
      "revalidate",
      "fetchCache",
      "runtime",
      "preferredRegion",
      "maxDuration",
    ];
    const ALLOWED = new Set([...HTTP_METHODS, ...SEGMENT_CONFIG, "generateStaticParams"]);

    const violations: string[] = [];
    let scanned = 0;
    let handlersSeen = 0;
    for (const f of SOURCES) {
      if (!isRouteHandler(f.rel)) continue;
      scanned++;
      const exported = topLevelExportNames(f.code);
      // A route that exports no handler at all is a route nothing can call.
      if (!exported.some((name) => HTTP_METHODS.includes(name))) {
        violations.push(`${f.rel}: exports no HTTP method handler`);
      } else {
        handlersSeen++;
      }
      for (const name of exported) {
        if (!ALLOWED.has(name)) violations.push(`${f.rel}: exports ${name}, which next build refuses`);
      }
    }
    expect(violations).toEqual([]);
    // The scan must have found the routes: a broken `isRouteHandler` would make this rule vacuous.
    // The three non-/api handlers are inside the count, which `isApiRoute` alone would have missed: the
    // compliance export, the WM-number deep link, and the demo personas' sign-in form (/sign-in/persona).
    expect(scanned, "no route.ts files were scanned").toBeGreaterThanOrEqual(20);
    expect(handlersSeen).toBe(scanned);
    expect(SOURCES.filter((f) => isRouteHandler(f.rel) && !isApiRoute(f.rel)).length).toBe(3);
  });

  it("G19 self-check — the export scanner sees each spelling a route could use", () => {
    // A scanner that silently matched nothing would make G19 pass for the wrong reason.
    expect(topLevelExportNames('export const dynamic = "force-dynamic";')).toEqual(["dynamic"]);
    expect(topLevelExportNames("export async function GET(req: Request) {}")).toEqual(["GET"]);
    expect(topLevelExportNames("export function POST() {}")).toEqual(["POST"]);
    expect(topLevelExportNames("export const { GET, POST } = handlers;")).toEqual(["GET", "POST"]);
    expect(topLevelExportNames("export default handler;")).toEqual(["default"]);
    expect(topLevelExportNames("export const WINDOW_MS = 15 * 60_000;")).toEqual(["WINDOW_MS"]);
    // Type-only exports are erased before the framework sees the module.
    expect(topLevelExportNames("export type Foo = string;\nexport interface Bar { a: 1 }")).toEqual([]);
    // Not top level: an `export` inside a string or an indented line is not a module export.
    expect(topLevelExportNames("  export const nested = 1;")).toEqual([]);
  });

  it("G10 — after() from next/server is never used (audit writes are awaited, I3)", () => {
    const violations: string[] = [];
    for (const f of SOURCES) {
      for (const ref of extractImports(f)) {
        if (ref.specifier !== "next/server") continue;
        for (const n of ref.names) if (n === "after" || n === "unstable_after") violations.push(`${f.rel}: imports ${n} from next/server`);
        if (ref.namespace && /\.(?:unstable_)?after\s*\(/.test(f.code)) violations.push(`${f.rel}: calls after() through a next/server namespace`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("G11 — multi-value URL keys are repeated bare keys: no `[]=` and no \"status[]\" / \"priority[]\" / \"slaStatus[]\" / \"action[]\" literals (convention 12)", () => {
    // CONTRACT-GAP: §g S3 tests require validation.test.ts to assert that `{ "status[]": "NEW" }` is IGNORED, which
    // needs the literal in a test file. G11 says "anywhere under src/"; the conservative reconciliation is to scan
    // every non-test file strictly and exempt *.test.ts (a test probing the forbidden encoding is not a writer).
    const bracketEq = "[]" + "=";
    const keys = ["status", "priority", "slaStatus", "action"];
    const violations: string[] = [];
    for (const f of SOURCES) {
      if (f.rel === SELF || f.rel.endsWith(".test.ts") || f.rel.endsWith(".test.tsx")) continue;
      if (f.code.includes(bracketEq)) violations.push(`${f.rel}: contains ${bracketEq}`);
      for (const key of keys) {
        for (const q of ['"', "'", "`"]) {
          const literal = `${q}${key}[]${q}`;
          if (f.code.includes(literal)) violations.push(`${f.rel}: contains ${literal}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("G13 — the health probe exists, imports only @/lib/db and @/lib/env, exports force-dynamic, returns two booleans with Cache-Control: no-store, and touches no session, viewer or audit writer (Decision #57)", () => {
    // Not vacuous on purpose: the deploy workflow's smoke step and the Cloud Run probe depend on this file, so its
    // absence is a failure, not a slice that has not landed yet.
    const f = byRel.get(HEALTH_ROUTE);
    expect(f, `${HEALTH_ROUTE} missing`).toBeDefined();
    if (!f) return;
    const violations: string[] = [];
    // `@/lib/logger` joined the allowlist in the security scanner sweep (2026-09-20): the probe's failure path used
    // to `console.error` a label derived from the caught error, which is CWE-209.
    // It is the third import this file may hold and the list is still closed — the logger imports only
    // `@/lib/errors`, touches no session, viewer or audit writer, and cannot reach the database, so the
    // probe's "no dependencies of its own" property survives.
    const allowed = new Set(["@/lib/db", "@/lib/env", "@/lib/logger"]);
    for (const ref of extractImports(f)) {
      if (ref.typeOnly) continue;
      if (!allowed.has(ref.id)) violations.push(`imports ${ref.specifier}`);
      if (ref.id === "@/lib/db") {
        if (ref.namespace) violations.push("namespace import of @/lib/db");
        for (const n of ref.names) if (n !== "prisma") violations.push(`imports ${n} from @/lib/db`);
      }
      if (ref.id === "@/lib/env") {
        if (ref.namespace) violations.push("namespace import of @/lib/env");
        // `envInvariantKeys` joined `assertServingInvariants` in the security scanner follow-up (2026-09-20): the
        // probe logs the gate's offending env KEY NAMES as a structured field, because `logError`
        // records no message and a 503 that says only "Error" in Cloud Logging is undiagnosable. It
        // is a pure predicate over a thrown value — no env read, no I/O — so the probe's "no
        // dependencies of its own" property is unchanged. The list is still closed.
        const envAllowed = new Set(["assertServingInvariants", "envInvariantKeys"]);
        for (const n of ref.names) if (!envAllowed.has(n)) violations.push(`imports ${n} from @/lib/env`);
      }
    }
    if (!/\bexport\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(f.code)) violations.push('missing export const dynamic = "force-dynamic"');
    if (!f.code.includes("assertServingInvariants()")) violations.push("does not run the serving-invariant gate");
    if (!f.code.includes("prisma.$queryRaw`SELECT 1`")) violations.push("does not probe the database with SELECT 1");
    if (!f.code.includes('"Cache-Control": "no-store"')) violations.push("missing Cache-Control: no-store");
    if (!f.code.includes("{ ok: true, db: true }")) violations.push("missing the { ok: true, db: true } body");
    if (!f.code.includes("{ ok: false, db: false }")) violations.push("missing the { ok: false, db: false } body");
    if (!f.code.includes("status: 503")) violations.push("failure is not a 503");
    for (const needle of ["requireViewerOrThrow(", "getViewer(", "auth(", "writeAudit", "recordView", "recordDenied", "headers()", "cookies("]) {
      if (f.code.includes(needle)) violations.push(`contains ${needle}`);
    }
    expect(violations).toEqual([]);
  });

  it("G14 — every Wave A table is either append-only at the DB or has an audited mutation path (Decision #60)", () => {
    // The claim this rule defends: no Wave A table can be changed without leaving evidence. Two ways
    // to satisfy it, and the migration must say which for every table.
    //   append-only  → a BEFORE UPDATE OR DELETE trigger (IngestReceipt, SlaAlert)
    //   state table  → a BEFORE DELETE trigger, plus the audit action its transitions write
    // The scan reads the SQL, not the TypeScript, because the DB is what actually holds the line.
    //
    // THE ONE FOLDER IS DELIBERATE HERE, unlike G15 / G17 / G18 which read the whole history
    // (integration round 3 checked this rather than widening it by reflex). G14's second half is an
    // EXACT-EQUALITY claim — `guardedTables(...)` must equal the two lists below — so its input has to
    // be the migration that declares the Wave A table universe and nothing else. Fed the whole stream
    // it would see Wave B's thirteen guarded tables as well and fail on every one of them, which is
    // G18's rule, not this one. What that scoping does NOT cover — a later migration DROPPING one of
    // these triggers — is covered from the other side: `src/lib/db.integration.test.ts` exercises the
    // live triggers against a real database, so a dropped guard fails there.
    const migration = readMigration(WAVE_A_MIGRATION);
    expect(migration, "the wave_a_constraints migration is missing").toBeTruthy();

    const APPEND_ONLY = ["IngestReceipt", "SlaAlert"];
    /**
     * The state tables, each with the entity type its rows are audited under and the audit actions its
     * transitions write. This is the rule's data, not a restatement of the enum: the table names are
     * compared against the triggers the migration actually creates (so a sixth guarded table fails here
     * by omission) and the action names against the modules that actually write audit rows (so an
     * action nobody writes fails too).
     */
    const STATE_TABLES: Record<string, { entityType: string; actions: readonly string[] }> = {
      Attachment: {
        entityType: "ATTACHMENT",
        // Wave B landed `ATTACHMENT_INTENT_CREATED`, which Wave A had been borrowing from
        // `ATTACHMENT_ADDED` with `metadata.stage: "intent"`. It is a real transition
        // (null → PENDING), so it is declared here rather than treated as a read.
        actions: ["ATTACHMENT_INTENT_CREATED", "ATTACHMENT_ADDED", "ATTACHMENT_REMOVED"],
      },
      MessageDelivery: {
        entityType: "MESSAGE_DELIVERY",
        // MESSAGE_LEASED is a real transition (QUEUED → LEASED, src/server/outbox.ts); the hard-coded
        // list this rule used to carry omitted it and nothing noticed.
        // Wave B adds two more, declared here for the same reason MESSAGE_LEASED was:
        // MESSAGE_CANCELLED (QUEUED → CANCELLED, src/server/retractions.actions.ts) and
        // MESSAGE_BOUNCED (SENT → BOUNCED, src/server/outbox.ts).
        actions: [
          "MESSAGE_QUEUED",
          "MESSAGE_LEASED",
          "MESSAGE_SENT",
          "MESSAGE_FAILED",
          "MESSAGE_CANCELLED",
          "MESSAGE_BOUNCED",
        ],
      },
      SuspendedIntake: {
        entityType: "SUSPENDED_INTAKE",
        // `INTAKE_DISCARDED` likewise: Wave A wrote it as `INTAKE_SUSPENDED` with
        // `metadata.detail: "DISCARDED_BY_REVIEWER"`, and Wave B gave it its own enum value.
        actions: ["INTAKE_SUSPENDED", "INTAKE_RELEASED", "INTAKE_DISCARDED"],
      },
    };
    const NO_HARD_DELETE = Object.keys(STATE_TABLES);
    const violations: string[] = [];
    for (const table of APPEND_ONLY) {
      // Plain substring searches: the interpolated table name carries no pattern syntax, so the
      // `new RegExp(…)` these replace was a security scanner CWE-185 finding for no gain.
      if (!migration.includes(`BEFORE UPDATE OR DELETE ON "${table}"`)) {
        violations.push(`${table}: no append-only trigger`);
      }
      if (!migration.includes(`BEFORE TRUNCATE ON "${table}"`)) violations.push(`${table}: no truncate guard`);
    }
    for (const table of NO_HARD_DELETE) {
      if (!migration.includes(`BEFORE DELETE ON "${table}"`)) violations.push(`${table}: rows can be deleted`);
      if (!migration.includes(`BEFORE TRUNCATE ON "${table}"`)) violations.push(`${table}: no truncate guard`);
    }
    expect(violations).toEqual([]);

    // Nothing the migration guards may be missing from the two lists above. The classification comes
    // out of the trigger statements themselves, so a later Wave that adds a table with a BEFORE DELETE
    // trigger and no declared transitions fails this rule by omission — which is the whole point.
    const guards = guardedTables(migration);
    expect(guards.appendOnly, "append-only tables in the migration are not the ones G14 declares").toEqual(
      [...APPEND_ONLY].sort(),
    );
    expect(guards.state, "state tables in the migration are not the ones G14 declares").toEqual([...NO_HARD_DELETE].sort());

    // Every state table's transitions have a named audit action in the catalog AND a writer that
    // persists it. Catalog membership alone is not evidence of anything: the catalog is a union tsc
    // already pins to the Prisma enum, so the writers are what this half reads.
    const catalog = new Set(auditCatalogActions(byRel.get("src/types/domain.ts")?.code ?? ""));
    expect(catalog.size, "the AuditAction catalog could not be parsed out of src/types/domain.ts").toBeGreaterThan(0);
    const writers = SOURCES.filter(isAuditWriterModule);
    expect(writers.length, "no audit writers found under src/server/** or src/jobs/**").toBeGreaterThan(0);
    const written = writers.flatMap((f) => auditEntryLiterals(f));

    const declaredBy = new Map<string, string>();
    for (const [table, { entityType, actions }] of Object.entries(STATE_TABLES)) {
      for (const action of actions) {
        declaredBy.set(action, table);
        if (!catalog.has(action)) violations.push(`${table}: ${action} is not in the AuditAction catalog`);
        if (!written.some((e) => e.action === action && e.entityType === entityType)) {
          violations.push(`${table}: no audit-entry literal under src/server/** or src/jobs/** writes ${action} / ${entityType}`);
        }
      }
    }

    // The other direction closes the same gap from the writers' side: a transition written against one
    // of these tables that the declaration above does not name is drift. Read-audits are not
    // transitions (ATTACHMENT_VIEWED carries no fieldChanged) and are deliberately out of scope.
    const tableByEntityType = new Map(Object.entries(STATE_TABLES).map(([table, spec]) => [spec.entityType, table]));
    for (const entry of written) {
      if (entry.entityType === null || entry.fieldChanged === null) continue;
      const table = tableByEntityType.get(entry.entityType);
      if (table === undefined) continue;
      if (declaredBy.get(entry.action) !== table) {
        violations.push(`${entry.rel}: ${entry.action} changes ${table}.${entry.fieldChanged} but is not one of ${table}'s declared transitions`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("G15 — the client-API (public) role can never read a Wave A table (I1)", () => {
    // `ALTER DEFAULT PRIVILEGES` grants new tables to the APP role only, so the public role gets
    // nothing by default — but "nothing by default" is an argument, and this is the assertion. Both
    // the migration's privilege floor and the operator-run grant file must name every new table in a
    // REVOKE from wm_helpdesk_public, and neither may GRANT anything but the two client-readable
    // relations to it — by name, by blanket grant, by default privilege or by role membership. The
    // scan is per statement and identifier-based (see clientRoleGrantViolations); the scanner
    // self-check above proves it fails on each of those forms.
    //
    // `"Ticket"` is the second half of the rule. It is the one base table the client role reads, and
    // Wave A widened it (requesterPhone, householdId, requesterExternalId, isComplaint, complaintFiledAt,
    // escalationTarget, externalRef, externalId, linkedFromTicketId, brand, source) on top of description
    // and clientReference. A table-wide `GRANT SELECT ON "Ticket"` covers every one of those and every
    // column the table will ever gain, so the grant must be column-scoped to the projection below — and
    // the TypeScript projection must not drift from it either, which is the last assertion here.
    const files = [
      {
        // INTEGRATION ROUND 3: the WHOLE migration history in creation order, not the one folder that
        // first created these tables — the same correction G17 and G18 already carry, applied to the
        // rule that guards the OLDER table set. A REVOKE belongs wherever the object is created, but a
        // GRANT can be written anywhere: a later migration that handed `wm_helpdesk_public` a Wave A
        // table was previously visible to neither G15 (which read one folder) nor G17 (whose table
        // list is Wave B's). Widening the input closes that seam and cannot weaken the rule — every
        // statement the named folder contributed is still in the stream.
        rel: "prisma/migrations/*/migration.sql",
        sql: allMigrationSql(),
        // No migration grants the client role anything but the two client-readable relations; none of
        // them names "Ticket" at all. The column-scoped projection lives in the operator-run file.
        columnScoped: undefined as Record<string, readonly string[]> | undefined,
      },
      {
        rel: RUNTIME_ROLES_SQL,
        sql: readRepoFile(RUNTIME_ROLES_SQL),
        columnScoped: { Ticket: CLIENT_TICKET_COLUMNS },
      },
    ];
    const violations: string[] = [];
    for (const { rel, sql, columnScoped } of files) {
      expect(sql, `${rel} is missing`).toBeTruthy();
      violations.push(...clientRoleGrantViolations(rel, sql, WAVE_A_TABLES, PUBLIC_READABLE, { columnScoped }));
    }
    expect(violations).toEqual([]);

    // One allowlist, THREE places: the granted columns, and BOTH `"Ticket"` projections the client
    // path reads through. Pinning only the first left the other granted by nobody and pinned by
    // nothing — see `clientTicketSharedSelectColumns`.
    const clientViewCode = byRel.get(CLIENT_VIEW)?.code ?? "";
    const projection = clientTicketSelectColumns(clientViewCode);
    expect(projection, "getClientTicketView's Ticket projection could not be parsed").toBeTruthy();
    expect([...(projection ?? [])].sort()).toEqual([...CLIENT_TICKET_COLUMNS].sort());

    const shared = clientTicketSharedSelectColumns(clientViewCode);
    expect(shared, "CLIENT_TICKET_SELECT could not be parsed").toBeTruthy();
    expect([...(shared ?? [])].sort()).toEqual([...CLIENT_TICKET_COLUMNS].sort());
  });

  it("G16 — the client-visible view exposes authorKind and retracted, never authorId or a retracted body (I1, Decisions #65, #101)", () => {
    // The view is redefined by whichever migration LAST creates it, so this FINDS that migration rather
    // than naming one — and takes the LAST definition inside it. Pinning a folder is what made this
    // rule decorative the moment Wave B rebuilt the view: the Wave A name went on asserting a
    // definition the database no longer had. Naming the Wave B folder instead only moves the same
    // defect one migration along, so the input is derived.
    const defining = migrationDefiningView("ClientVisibleComment");
    expect(defining, "no migration under prisma/migrations creates the ClientVisibleComment view").toBeTruthy();
    if (!defining) return;
    const migration = defining.sql;
    const body = lastViewDefinition(migration, "ClientVisibleComment");
    expect(body, `the view definition is missing from ${defining.rel}`).toBeTruthy();
    if (body === null) return;

    // The rule is an allowlist over the parsed SELECT list, not a denylist of spellings: the view is
    // written with quoted camelCase identifiers (an unquoted `macroId` would not even resolve), so a
    // `.not.toContain("c.macroId")` could never fire on the edit that actually adds the column. Any
    // added, renamed, aliased or computed column fails the comparison below whatever it looks like.
    const columns = clientVisibleViewColumns(migration);
    expect(columns, "the view's SELECT list could not be parsed").toBeTruthy();
    expect([...(columns ?? [])].sort()).toEqual([...CLIENT_VISIBLE_COLUMNS].sort());
    for (const forbidden of ["authorId", "visibility", "macroId", "piiRedacted", "piiRedactionCount"]) {
      expect(columns ?? [], `view must not select ${forbidden}`).not.toContain(forbidden);
    }
    // A join could widen the view without changing any column name we expect to see. Wave B adds
    // EXACTLY ONE, to `CommentRetraction`, which holds a commentId, a reason and who retracted — no
    // message text of its own, so it cannot widen what the view exposes. Any other join fails here.
    const joins = [...body.matchAll(/\bJOIN\s+"([A-Za-z0-9_]+)"/gi)].map((m) => m[1]);
    expect(joins, "the view may join only CommentRetraction").toEqual(["CommentRetraction"]);
    expect(body, "the one join must be a LEFT join — an inner one would hide every un-retracted comment")
      .toMatch(/LEFT\s+JOIN\s+"CommentRetraction"/i);

    // The retraction blanks the BODY at the database. This is the half of Decision #101 that does not
    // depend on `src/server/client-view.ts` being correct: `wm_helpdesk_public` holds no privilege on
    // "Comment" or "CommentRetraction", so a withdrawn message is unreachable rather than unrendered.
    expect(body, "a retracted comment's body must be blanked in the view itself").toMatch(
      /CASE\s+WHEN\s+r\."commentId"\s+IS\s+NULL\s+THEN\s+c\.body\s+ELSE\s+''\s+END\s+AS\s+body/i,
    );
    expect(body).toContain('c."authorKind"');
    expect(body).toContain("WHERE c.visibility = 'PUBLIC'");
    // The module that reads it turns the enum into a two-value display string and nothing else, and
    // refuses a row that claims retraction while still carrying a body (belt and braces over the CASE).
    const view = byRel.get(CLIENT_VIEW);
    expect(view?.code).toContain("authorDisplayFor");
    expect(view?.code).not.toContain("authorId");
    expect(view?.code, "the DTO must render the placeholder, never the stored body").toContain(
      "CLIENT_RETRACTED_BODY",
    );
    expect(view?.code).toMatch(/raw\.retracted && raw\.body !== ""/);
  });

  it("G16 — ClientVisibleOpeningMessage carries BOTH opening-entry gates in its own WHERE (I1, Decision #117)", () => {
    // The second client-visible view, and the reason it exists: the opening entry used to be gated in
    // `src/server/client-view.ts` over three `"Ticket"` columns the client role had been granted, so a
    // mistake in an application-side allowlist could have returned a staff-composed description to the
    // client it was written about. Here the gate is a row filter, which is the same construction
    // `ClientVisibleComment` uses for `visibility = 'PUBLIC'` — there is no row to return.
    //
    // Found rather than named, like G16 above: whichever migration LAST defines the view is the one
    // the database has.
    const defining = migrationDefiningView("ClientVisibleOpeningMessage");
    expect(defining, "no migration under prisma/migrations creates the ClientVisibleOpeningMessage view").toBeTruthy();
    if (!defining) return;
    const body = lastViewDefinition(defining.sql, "ClientVisibleOpeningMessage");
    expect(body, `the view definition is missing from ${defining.rel}`).toBeTruthy();
    if (body === null) return;
    const flat = body.replace(/\s+/g, " ").trim();

    // The projection, as WRITTEN TEXT including the aliases. `t.description AS body` is a renamed bare
    // column — the masquerade the comment view's parser exists to catch — so it is pinned literally
    // rather than by its alias: any added, renamed, re-aliased or computed column fails this line.
    const select = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(body);
    expect(select, "the view's SELECT list could not be parsed").toBeTruthy();
    expect(splitTopLevel(select?.[1] ?? "").map((c) => c.replace(/\s+/g, " ").trim())).toEqual([
      't.id AS "ticketId"',
      "t.source",
      "t.description AS body",
      't."createdAt"',
    ]);
    // ONE table and NO join. A join could widen what the client role reads without changing a column
    // name anyone expected to see — the same argument G16 makes about the comment view, except that
    // here the answer is zero joins rather than one.
    expect([...body.matchAll(/\bJOIN\s+"([A-Za-z0-9_]+)"/gi)].map((m) => m[1])).toEqual([]);
    expect(flat).toMatch(/FROM "Ticket" t WHERE/i);

    // GATE 1 — the source allowlist, compared against the TypeScript constant in BOTH directions. A
    // source moved onto REQUESTER_AUTHORED_SOURCES without rebuilding the view, or into the view
    // without the constant, fails here; and every excluded channel is named in the failure.
    const inList = /\bt\.source\s+IN\s*\(([^)]*)\)/i.exec(flat);
    expect(inList, "the view must gate on t.source IN (…)").toBeTruthy();
    const granted = splitTopLevel(inList?.[1] ?? "").map((v) => v.trim().replace(/'/g, ""));
    expect([...granted].sort()).toEqual([...REQUESTER_AUTHORED_SOURCES].sort());
    for (const excluded of TICKET_SOURCES.filter((src) => !(REQUESTER_AUTHORED_SOURCES as readonly string[]).includes(src))) {
      expect(granted, `${excluded} writes a desk-composed description and must not be admitted`).not.toContain(excluded);
    }

    // GATE 2 — the released-held-mail marker, as the exact predicate, tied to the same constant
    // `releaseHeldIntake` writes. `left(…, length(…))` rather than LIKE: no character of the marker
    // can be read as a wildcard, and it is the same test as JavaScript's `startsWith`.
    expect(flat).toContain(
      `(t."externalId" IS NULL OR left(t."externalId", length('${INTAKE_RELEASE_EXTERNAL_ID_PREFIX}')) <> '${INTAKE_RELEASE_EXTERNAL_ID_PREFIX}')`,
    );

    // The module that reads it: through the view, never through the columns. The client role is not
    // granted `description`, `source` or `externalId` (CLIENT_TICKET_COLUMNS above), so a select on one
    // would fail at the database — but the read path must not even ask, and the gate's SECOND belt
    // must still be here.
    const view = byRel.get(CLIENT_VIEW);
    expect(view?.code).toContain('FROM "ClientVisibleOpeningMessage"');
    expect(view?.code, "the second belt over the view's own source column").toContain(
      "REQUESTER_AUTHORED_SOURCE_SET.has(row.source)",
    );
    expect(view?.code, "externalId is the view's business now").not.toMatch(/\bexternalId:\s*true/);
  });

  it("G17 — the client-API (public) role can never read a Wave B table either (I1, Decision #95)", () => {
    // The same rule as G15, over the tables Wave B adds. `ALTER DEFAULT PRIVILEGES` grants new tables
    // to the APP role only, so the public role gets nothing by default — but "nothing by default" is an
    // argument, and this is the assertion. Both the migrations' privilege floor and the operator-run
    // grant file must name every one of them in a REVOKE from wm_helpdesk_public, and neither may GRANT
    // anything but the two client-readable relations to it.
    //
    // BOTH inputs are derived. The privilege floor is the WHOLE migration history in creation order,
    // not one named folder: a REVOKE belongs wherever the object is created, and pinning the
    // constraints migration is what forced `20260920000300_wave_b_integration_r1` to write its
    // `ReportingStatusChange` REVOKE by hand with a comment explaining that this rule could not see it.
    // The table list comes out of `prisma/schema.prisma` (see WAVE_B_TABLES), so a model added later is
    // scanned whether or not anyone extends a list.
    const files = [
      { rel: "prisma/migrations/*/migration.sql", sql: allMigrationSql() },
      { rel: RUNTIME_ROLES_SQL, sql: readRepoFile(RUNTIME_ROLES_SQL) },
    ];
    expect(WAVE_B_TABLES.length, "no Wave B tables were derived from prisma/schema.prisma").toBeGreaterThan(0);
    const violations: string[] = [];
    for (const { rel, sql } of files) {
      expect(sql, `${rel} is missing`).toBeTruthy();
      violations.push(...clientRoleGrantViolations(rel, sql, WAVE_B_TABLES, PUBLIC_READABLE));
    }
    expect(violations).toEqual([]);
  });

  it("G18 — every Wave B table is append-only, no-hard-delete, or one of the two declared exceptions, and every state table's transitions are audited (Decision #95, CONTRACT §1.7)", () => {
    // G14's shape, over Wave B's tables — BOTH halves of it. The two families come out of the TRIGGERS
    // the migrations actually leave in place, so a fourteenth table added later with no guard fails
    // here by omission, and the two deliberate exceptions are named, so "it has no trigger" can never
    // be an oversight that looks like a decision.
    //
    // Both of that claim's inputs are derived, because a hardcoded pair could not support it: the
    // table universe is `prisma/schema.prisma` minus the closed pre-Wave-B set (a fourteenth table
    // declared in the schema is in the universe the moment it is declared, so it cannot pass by being
    // absent from a literal array), and the triggers are read across the whole migration history in
    // creation order (a guard added — or dropped — by a later migration counts, and a guard named only
    // in the constraints migration is no longer the only guard that exists).
    //
    // The second half is the one this rule used to be missing, and it is the half that carries the
    // claim: a `BEFORE DELETE` trigger only says a row cannot VANISH. It says nothing about whether
    // changing one leaves evidence, and CONTRACT §1.7 requires both — a state table is one "whose
    // condition changes … and then every transition writes an audit row in the same transaction".
    // Without it a Wave B state table whose transitions leave no ledger entry passed by silence.
    const migration = allMigrationSql();
    expect(migration, "no migration SQL was found under prisma/migrations").toBeTruthy();
    expect(WAVE_B_TABLES.length, "no Wave B tables were derived from prisma/schema.prisma").toBeGreaterThan(0);
    // The derived universe is only as good as its historical half: a pre-Wave-B model that is renamed
    // or dropped would otherwise land in WAVE_B_TABLES and widen both this rule and G17 by accident.
    expect(
      PRE_WAVE_B_TABLES.filter((table) => !PRISMA_MODELS.includes(table)),
      "a pre-Wave-B model is no longer declared in prisma/schema.prisma — PRE_WAVE_B_TABLES is stale",
    ).toEqual([]);

    // DemoOutboxMessage: the demo's Outbox (src/lib/demo/outbox.ts), insert-only like the other records.
    const APPEND_ONLY = ["CommentRetraction", "DemoOutboxMessage", "FollowUpNudge", "IdentityVerification", "ReviewStamp"];
    /**
     * The state tables, each with the entity type its rows are audited under and the audit actions its
     * transitions write. As in G14 this is the rule's data, not a restatement of the enum: the table
     * names are compared against the triggers the migration actually creates (so an eighth guarded
     * table fails by omission) and the action names against the modules that actually write audit rows
     * (so an action nobody writes fails too).
     *
     * `entityType` is NOT the table name, and cannot be derived from it. `TicketFollower` rows are
     * audited under `TICKET` with `fieldChanged: "follower"` — the ticket is the record a reviewer
     * reads, the follower row is how the desk stores it. That is also why G14's OTHER direction (every
     * written transition against one of these entity types must be declared) is deliberately not
     * carried over: `TICKET` is the entity type of nearly every audit row in the system, and
     * `PII_REDACTED` lands on `TICKET_LINK` as well as its own table, so entityType is not a table
     * discriminator in Wave B the way it happened to be across Wave A's three.
     */
    const STATE_TABLES: Record<string, { entityType: string; actions: readonly string[] }> = {
      ClientApiToken: {
        entityType: "API_TOKEN",
        actions: ["API_TOKEN_CREATED", "API_TOKEN_REVOKED", "API_TOKEN_ROTATED"],
      },
      Notification: {
        entityType: "NOTIFICATION",
        // Deliberately none. Argued under UNAUDITED_STATE_TABLES below, where it is also asserted.
        actions: [],
      },
      RequesterSuppression: {
        entityType: "SUPPRESSION",
        actions: ["SUPPRESSION_ADDED", "SUPPRESSION_REMOVED"],
      },
      TicketFollower: {
        entityType: "TICKET",
        actions: ["TICKET_FOLLOWED", "TICKET_UNFOLLOWED"],
      },
      TicketLink: {
        entityType: "TICKET_LINK",
        actions: ["TICKET_LINK_ADDED", "TICKET_LINK_REMOVED"],
      },
      WebhookDelivery: {
        entityType: "WEBHOOK_DELIVERY",
        actions: ["WEBHOOK_DELIVERY_SENT", "WEBHOOK_DELIVERY_FAILED", "WEBHOOK_DELIVERY_DEAD"],
      },
      WebhookEndpoint: {
        entityType: "WEBHOOK_ENDPOINT",
        actions: ["WEBHOOK_ENDPOINT_CREATED", "WEBHOOK_ENDPOINT_UPDATED", "WEBHOOK_ENDPOINT_REVOKED"],
      },
    };
    const NO_HARD_DELETE = Object.keys(STATE_TABLES);
    /**
     * The state tables whose transitions are deliberately NOT audited, and this is the whole list.
     *
     * `Notification`: a row is DERIVED from an event that is already in the ledger, so auditing the
     * derivation would double the ledger's volume to record nothing new (CONTRACT §3.3 rule 3). What IS
     * audited is the preference change, the follow/unfollow and the job run that produced the digest.
     * `markNotificationsRead` therefore stamps `readAt` with no audit row, on purpose. §1.7 used to
     * offer "a notification read" as its example of an audited transition, which said the opposite of
     * rule 3; that example has been withdrawn in favour of rule 3, which is the one the code follows.
     *
     * This is an argument, not a loophole, and the three assertions below keep it falsifiable: the
     * entry must be declared here rather than passing by silence, the catalog must still offer no
     * per-notification action to write, and nothing may actually write one. Start auditing notification
     * transitions and this rule fails — at which point `Notification` moves into the audited set above,
     * which is exactly the edit that should be forced.
     */
    const UNAUDITED_STATE_TABLES = ["Notification"];
    /**
     * Deliberately unguarded, and this is the whole list. `ComposerDraft`: an unsent draft is not a
     * record — nothing in it has been seen by a client, entered the ledger or left the desk, and
     * "discard my draft" has to actually discard it. `PushSubscription`: a device-side artefact the
     * push service itself declares dead with HTTP 410, which we must then prune.
     */
    const UNGUARDED = ["ComposerDraft", "PushSubscription"];
    expect([...APPEND_ONLY, ...NO_HARD_DELETE, ...UNGUARDED].sort()).toEqual([...WAVE_B_TABLES].sort());

    // One parse of the history feeds both directions: which declared table is missing its guard, and
    // which guarded table nobody declared. A text scan for `BEFORE DELETE ON "X"` would also report a
    // trigger a later migration DROPPED, which is why this goes through `guardedTables`.
    const guards = guardedTables(migration);
    const appendOnlyGuards = new Set(guards.appendOnly);
    const stateGuards = new Set(guards.state);
    const truncateGuards = new Set(guards.truncateGuarded);
    const violations: string[] = [];
    for (const table of APPEND_ONLY) {
      if (!appendOnlyGuards.has(table)) violations.push(`${table}: no append-only trigger`);
      if (!truncateGuards.has(table)) violations.push(`${table}: no truncate guard`);
    }
    for (const table of NO_HARD_DELETE) {
      if (!stateGuards.has(table)) violations.push(`${table}: rows can be deleted`);
      if (!truncateGuards.has(table)) violations.push(`${table}: no truncate guard`);
    }
    for (const table of UNGUARDED) {
      if (appendOnlyGuards.has(table) || stateGuards.has(table)) {
        violations.push(`${table}: guarded, but G18 declares it as a deliberate exception`);
      }
    }
    expect(violations).toEqual([]);

    // The classification comes out of the trigger statements themselves, so a later table with a guard
    // and no declaration fails by omission — which is the whole point. Restricted to Wave B's tables
    // because the history also carries Wave A's and the core schema's guards, which G14 and the
    // audit-immutability migration own; a Wave B table is in the universe above whatever it is called.
    const isWaveB = (table: string): boolean => WAVE_B_TABLES.includes(table);
    expect(guards.appendOnly.filter(isWaveB), "append-only Wave B tables are not the ones G18 declares").toEqual(
      [...APPEND_ONLY].sort(),
    );
    expect(guards.state.filter(isWaveB), "guarded state tables in Wave B are not the ones G18 declares").toEqual(
      [...NO_HARD_DELETE].sort(),
    );

    // --- The audited half. Catalog membership alone is not evidence of anything: the catalog is a
    // union tsc already pins to the Prisma enum, so the WRITERS are what this reads, exactly as G14's
    // second half does.
    const catalog = new Set(auditCatalogActions(byRel.get("src/types/domain.ts")?.code ?? ""));
    expect(catalog.size, "the AuditAction catalog could not be parsed out of src/types/domain.ts").toBeGreaterThan(0);
    const writers = SOURCES.filter(isAuditWriterModule);
    expect(writers.length, "no audit writers found under src/server/** or src/jobs/**").toBeGreaterThan(0);
    const sitesByWriter = writers.map((f) => ({ f, sites: auditActionSites(f) }));

    for (const [table, { entityType, actions }] of Object.entries(STATE_TABLES)) {
      for (const action of actions) {
        if (!catalog.has(action)) {
          violations.push(`${table}: ${action} is not in the AuditAction catalog`);
          continue;
        }
        const persisted = sitesByWriter.some(({ f, sites }) => {
          // Strongest form: one audit-entry literal carries both the action name and the entity type.
          if (sites.some((s) => s.entityType === entityType && s.actions.includes(action))) return true;
          // Wave B also builds entries whose action is computed one step away — `action: verdict.action`
          // (src/jobs/webhook-dispatch.ts) and the `{ action, entityType: "TICKET_LINK" }` shorthand
          // `linkEntry` returns (src/server/ticket-links.actions.ts). Those are real writes, so the
          // pairing widens by EXACTLY one step: the module must both build an audit entry of this
          // entity type with a computed action AND spell this action name itself. A module that only
          // mentions the name, or only builds entries of some other entity type, still fails.
          if (!sites.some((s) => s.entityType === entityType && s.actions.length === 0)) return false;
          return screamingStringLiterals(f.code).has(action);
        });
        if (!persisted) {
          violations.push(
            `${table}: no audit writer under src/server/** or src/jobs/** persists ${action} / ${entityType}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);

    // The exception, stated rather than left to silence (see UNAUDITED_STATE_TABLES above).
    expect(
      Object.entries(STATE_TABLES)
        .filter(([, spec]) => spec.actions.length === 0)
        .map(([table]) => table),
      "a state table declaring no transitions must be argued in UNAUDITED_STATE_TABLES",
    ).toEqual(UNAUDITED_STATE_TABLES);
    expect(
      [...catalog].filter((a) => a.startsWith("NOTIFICATION_")),
      "the catalog gained a per-notification action: Notification's transitions are now auditable, so it belongs in G18's audited set",
    ).toEqual(["NOTIFICATION_PREFS_CHANGED"]);
    expect(
      writers.flatMap((f) => auditEntryLiterals(f)).filter((e) => e.entityType === "NOTIFICATION"),
      "something writes NOTIFICATION audit rows: move Notification out of UNAUDITED_STATE_TABLES and declare its transitions",
    ).toEqual([]);
  });

  it("G12 — nothing under src/ imports next/cache or calls revalidatePath/revalidateTag: one human mutation = one audited view (I3, Decision #45)", () => {
    // Every (app) page is force-dynamic and nothing uses the Data Cache, so there is nothing to revalidate.
    // A revalidation inside a server action additionally makes Next re-render the current page inside the
    // action response; on /tickets/[id] that is a second, duplicate TICKET_VIEWED row (a different requestId)
    // next to the one the UI's own router.refresh() produces. That single router.refresh() is the one audited
    // re-render per human mutation.
    const violations: string[] = [];
    for (const f of SOURCES) {
      if (f.rel === SELF) continue;
      for (const ref of extractImports(f)) {
        if (ref.specifier === "next/cache") violations.push(`${f.rel}: imports next/cache`);
      }
      for (const m of f.code.matchAll(/\b(?:unstable_)?(?:revalidatePath|revalidateTag|expirePath|expireTag)\s*\(/g)) {
        violations.push(`${f.rel}: calls ${m[0].trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
