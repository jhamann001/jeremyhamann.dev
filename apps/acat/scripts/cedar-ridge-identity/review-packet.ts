import { normalizeKey, normalizeName, sha256 } from "./canonical";
import type { Evidence, Manifest, ManifestRow } from "./contracts";
import { verifyManifestEvidence } from "./manifest";

const cell = (value: string | null) => (value ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** Contains PII. Write only to the restricted evidence directory, never Git/stdout. */
export function reviewPacket(manifest: Manifest, evidence: Evidence): string {
  verifyManifestEvidence(manifest, evidence);
  const names = new Map(evidence.clients.map((client) => [client.userId, client.name]));
  const pending = manifest.rows.filter((row) => row.category !== "stable-name-agrees" && row.category !== "already-linked");
  const groups = new Map<string, ManifestRow[]>();
  for (const row of pending) {
    const groupKey = row.category === "stable-name-varies"
      ? `Name variation: ${row.candidateIds.join(",")}`
      : ["multiple-users", "joint-account-members"].includes(row.category) ? `Multiple users: ${normalizeKey(row.expected.apexAccountId)}`
      : `${row.category}: ${row.expected.id}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  const out = [
    "# ticket restricted operations identity review",
    "",
    `Generated: ${manifest.generatedAt}. Tracker extracted: ${manifest.trackerExtractedAt}. Source extracted: ${evidence.extractedAt}.`,
    `Manifest SHA-256: ${sha256(manifest)}. Source upstream freshness: **${evidence.upstreamFreshness}**.`,
    evidence.ownerCoverageAssumption
      ? `**COVERAGE IS OWNER-ASSUMED; THIS IS NOT UPSTREAM INGESTION VERIFICATION.** Accepted by ${cell(evidence.ownerCoverageAssumption.acceptedBy)} at ${cell(evidence.ownerCoverageAssumption.acceptedAt)}. Reference: ${cell(evidence.ownerCoverageAssumption.reference)}. Reason: ${cell(evidence.ownerCoverageAssumption.reason)}. This assumption grants no record assignment or production-write approval.`
      : evidence.upstreamFreshness === "verified" ? "Coverage basis: upstream verification recorded in source evidence. Record assignments still require review."
      : "**UPSTREAM FRESHNESS IS NOT VERIFIED; NO OWNER COVERAGE ASSUMPTION IS RECORDED.**",
    "",
    "This packet proposes candidates; it does not approve or apply any assignment. Premigration placeholder identity versions must be replaced by a fresh postmigration snapshot before apply. The final directory-bound manifest has a new digest and requires separate explicit approval.",
    "",
    `Population: ${manifest.rows.length} records; ${manifest.rows.filter((row) => row.expected.deletedAt === null).length} non-deleted; ${manifest.rows.filter((row) => row.expected.deletedAt !== null).length} deleted. Manual-review rows: ${pending.length}; groups: ${groups.size}.`,
    "",
    "For each record, record the complete sorted Cedar Ridge ID set OR an explicit unlinked exception, reviewer, review time, reason and supporting evidence reference. A joint proposal links all verified JOINT members of the exact receiving account; transfer-only participants are not account owners. Grouping does not approve any row. Preserve historical display names. A name-only link requires independent corroboration. Apparent tests are not automatically excluded.",
  ];
  for (const [key, rows] of groups) {
    out.push("", `## ${cell(key)}`, "", "| ACAT record | Historical name | Receiving account | Transfer ID | Deleted | Account members | Transfer participants | Candidates / proposed joint set |", "|---|---|---|---|---|---|---|---|");
    for (const row of rows) {
      const candidates = row.candidateIds.map((id) => `${names.get(id) ?? "UNKNOWN"} (${id})`).join("; ") || "None";
      out.push(`| ${cell(row.expected.id)} | ${cell(row.expected.clientName)} | ${cell(row.expected.apexAccountId)} | ${cell(row.expected.acatTransferId)} | ${row.expected.deletedAt ? "Yes" : "No"} | ${cell(row.accountCandidateIds.join("; "))} | ${cell(row.transferCandidateIds.join("; "))} | ${row.category === "joint-account-members" ? "PROPOSED COMPLETE JOINT SET: " : ""}${cell(candidates)} |`);
    }
    out.push("", "Decision(s), record IDs, reviewer, date, reason and corroborating source: **PENDING REVIEW**.");
  }
  const variationPeople = new Set(manifest.rows.filter((row) => row.category === "stable-name-varies").flatMap((row) => row.candidateIds));
  const duplicateNameGroups = new Map<string, number>();
  evidence.clients.forEach((client) => duplicateNameGroups.set(normalizeName(client.name), (duplicateNameGroups.get(normalizeName(client.name)) ?? 0) + 1));
  out.push("", `Control totals: name-variation people ${variationPeople.size}; source duplicate-name groups ${[...duplicateNameGroups.values()].filter((count) => count > 1).length}.`, "");
  return out.join("\n");
}
