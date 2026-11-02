import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { DEAL_STAGES } from "@/lib/data/deal-types";
import { validateDealInput } from "@/lib/data/deal-validate";
import {
  buildReconciliation,
  buildReviewCsv,
  dealInputToDbData,
  deHyperlink,
  formatReconciliation,
  mapReportRow,
  parseCsv,
  parseStage,
  readReviewCsv,
  recordsFromCsv,
  reportRecordFromObject,
  reviewPathFor,
  toCsv,
} from "@/lib/deals/import-csv";
import { parseDealName } from "@/lib/deals/parse-deal-name";
import {
  DEMO_SF_ID_PREFIX,
  demoDealCsvText,
  demoDealInputs,
} from "@/lib/deals/demo-deals";

// D4 import toolkit tests (TDD ticket ADR-6/§7). ALL fixture data is
// INVENTED (PII rule): FIX-/BAD-/DEMO- ids, Sample/Example/Mock-style names.

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, "fixtures", "deals-import.csv"),
  "utf8",
);
const FIXTURE_INVALID = readFileSync(
  path.join(import.meta.dirname, "fixtures", "deals-import-invalid.csv"),
  "utf8",
);

/** Map + validate every record the way scripts/import-deals.ts does. */
function mapAll(csvText: string) {
  return recordsFromCsv(csvText).map((record) => {
    const mapped = mapReportRow(record);
    return { ...mapped, errors: validateDealInput(mapped.input).errors };
  });
}

describe("parseCsv / toCsv (hand-rolled RFC-4180 subset — zero deps)", () => {
  it("parses quoted fields with commas, escaped quotes, and embedded newlines", () => {
    const text = `a,b,c\r\n"1,5","say ""hi""","line1\nline2"\r\n`;
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1,5", 'say "hi"', "line1\nline2"],
    ]);
  });

  it("handles LF-only files, a UTF-8 BOM, and no trailing newline", () => {
    expect(parseCsv("\uFEFF" + "x,y\n1,2")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });

  it("round-trips through toCsv", () => {
    const rows = [
      ["Deal: ID", "Deal: Deal Name"],
      ["FIX-1", 'weird "quoted", value\nwith newline'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("recordsFromCsv — header resolution", () => {
  it("resolves headers case-insensitively and via aliases", () => {
    const text = toCsv([
      ["deal: id", "DEAL: DEAL NAME", "Person: First Name", "Person: Last Name", "AUM", "AoA - New Stage", "Deal: Created Date", "Person: Entity ID"],
      ["FIX-9", "N - F - Joint - 1111", "Ari", "Alias", "10", "Won", "2026-01-01", "001X"],
    ]);
    const [rec] = recordsFromCsv(text);
    expect(rec.sfDealId).toBe("FIX-9");
    expect(rec.householdSfId).toBe("001X"); // via the "Person: Entity ID" alias
  });

  it("throws naming the missing required columns (headers only — no row data)", () => {
    const text = toCsv([
      ["Deal: ID", "Person: First Name"],
      ["FIX-9", "Ari"],
    ]);
    expect(() => recordsFromCsv(text)).toThrow(/Deal: Deal Name/);
    expect(() => recordsFromCsv(text)).toThrow(/AoA - New Stage/);
  });
});

describe("mapReportRow — TDD §3 crosswalk mapping (fixture)", () => {
  const rows = mapAll(FIXTURE);
  const byId = new Map(rows.map((r) => [r.input.sf_deal_id, r]));

  it("maps every fixture row and all 8 pass the frozen validateDealInput", () => {
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.errors).toEqual([]);
  });

  it("coerces $/comma amounts to numbers", () => {
    expect(byId.get("FIX-0001")!.input.amount).toBe(125000);
  });

  it("normalizes M/D/YYYY dates to YYYY-MM-DD", () => {
    expect(byId.get("FIX-0002")!.input.created_date).toBe("2026-06-15");
  });

  it("maps stage labels to the enum and keeps stage_raw provenance", () => {
    const r = byId.get("FIX-0005")!.input;
    expect(r.stage).toBe("WON");
    expect(r.stage_raw).toBe("Closed Won");
  });

  it("maps Yes/No booleans (statements default true, plaid default false)", () => {
    expect(byId.get("FIX-0005")!.input.statements).toBe(false);
    expect(byId.get("FIX-0001")!.input.statements).toBe(true);
    expect(byId.get("FIX-0001")!.input.plaid_linked).toBe(false);
  });

  it("maps blank and 'Unassigned' owners to the null owner pair", () => {
    for (const id of ["FIX-0006", "FIX-0008"]) {
      const r = byId.get(id)!.input;
      expect(r.owner_name).toBeNull();
      expect(r.owner_sf_user_id).toBeNull();
      expect(r.stage).toBe("LOST"); // the real-file unassigned pattern
    }
  });

  it("leaves cedar_ridge_user_id null for prospect-shaped rows", () => {
    expect(byId.get("FIX-0007")!.input.cedar_ridge_user_id).toBeNull();
  });

  it("backfills account fields from the deal-name parser", () => {
    const full = byId.get("FIX-0001")!.input;
    expect(full.transferring_firm).toBe("Fidelity");
    expect(full.account_type).toBe("Roth IRA");
    expect(full.account_last4).toBe("1234");
    // status-prefix form still parses
    expect(byId.get("FIX-0002")!.input.account_last4).toBe("8842");
    // $TBD → null last4; unparseable name → all null
    expect(byId.get("FIX-0003")!.input.account_last4).toBeNull();
    expect(byId.get("FIX-0005")!.input.account_type).toBeNull();
    // decorated last4
    expect(byId.get("FIX-0008")!.input.account_last4).toBe("7710");
    expect(byId.get("FIX-0008")!.parsed.confidence).toBe("high");
  });

  it("always stamps source=IMPORT with the row's sf_deal_id (ADR-2)", () => {
    for (const r of rows) {
      expect(r.input.source).toBe("IMPORT");
      expect(r.input.sf_deal_id).toMatch(/^FIX-\d{4}$/);
    }
  });
});

describe("review CSV — parse-and-review round trip + authority", () => {
  it("reviewPathFor lands beside the source file, outside the repo", () => {
    expect(reviewPathFor("/private/exports/deals-export.csv")).toBe(
      "/private/exports/deals-export.account-fields.review.csv",
    );
    expect(reviewPathFor("/private/exports/deals-export.CSV")).toBe(
      "/private/exports/deals-export.account-fields.review.csv",
    );
    // Same directory as the source by construction.
    expect(path.dirname(reviewPathFor("/a/b/c.csv"))).toBe("/a/b");
  });

  it("buildReviewCsv → readReviewCsv round-trips, and a reviewed row overrides the parser wholesale", () => {
    const records = recordsFromCsv(FIXTURE);
    const reviewRows = records.map((record) => {
      const { parsed, input } = mapReportRow(record);
      return { record, parsed, errors: validateDealInput(input).errors };
    });
    const reviewText = buildReviewCsv(reviewRows);
    const reviewMap = readReviewCsv(reviewText);
    expect(reviewMap.size).toBe(8);

    // Simulate the owner hand-correcting the unparseable row (FIX-0005 — its
    // parsed_client_name column carries the whole unsplit name).
    const uncorrectedRow =
      "FIX-0005,Household consolidation,Household consolidation,,,,none,,";
    expect(reviewText).toContain(uncorrectedRow);
    const corrected = reviewText.replace(
      uncorrectedRow,
      "FIX-0005,Household consolidation,Household consolidation,Fidelity,Trust,9042,none,,",
    );
    const correctedMap = readReviewCsv(corrected);
    const record5 = records.find((r) => r.sfDealId === "FIX-0005")!;
    const remapped = mapReportRow(record5, correctedMap.get("FIX-0005"));
    expect(remapped.input.transferring_firm).toBe("Fidelity");
    expect(remapped.input.account_type).toBe("Trust");
    expect(remapped.input.account_last4).toBe("9042");
    // A reviewed blank stays authoritative too (blanked cell → null).
    const remapped3 = mapReportRow(
      records.find((r) => r.sfDealId === "FIX-0003")!,
      correctedMap.get("FIX-0003"),
    );
    expect(remapped3.input.account_last4).toBeNull();
  });
});

describe("reconciliation report — counts + SF ids only (no PII in stdout)", () => {
  it("counts the fixture correctly", () => {
    const r = buildReconciliation(mapAll(FIXTURE));
    expect(r.total).toBe(8);
    expect(r.byStage).toEqual({
      POTENTIAL: 2,
      COMMITTED: 1,
      FUNDING: 1,
      WON: 2,
      LOST: 2,
    });
    expect(r.validationFailures).toEqual([]);
    expect(r.unparsedNameSfIds).toEqual(["FIX-0005"]);
    expect(r.nullOwner).toBe(2);
    expect(r.nullCedarRidgeUserId).toBe(1);
  });

  it("reports validation failures by row number + SF id + FIELD NAMES only", () => {
    const r = buildReconciliation(mapAll(FIXTURE_INVALID));
    expect(r.total).toBe(3);
    expect(r.validationFailures).toHaveLength(2);
    const Ferreira = r.validationFailures.find((f) => f.sfDealId === "BAD-0002")!;
    expect(Ferreira.fields).toContain("stage");
    const Bartell = r.validationFailures.find((f) => f.sfDealId === null)!;
    expect(Bartell.rowNumber).toBe(3);
    expect(Bartell.fields).toEqual(
      expect.arrayContaining(["sf_deal_id", "client_first_name", "amount", "created_date"]),
    );
  });

  it("NEVER leaks a client/household name or an amount into the formatted report", () => {
    const rows = mapAll(FIXTURE);
    const out = formatReconciliation(buildReconciliation(rows));
    for (const row of rows) {
      expect(out).not.toContain(row.input.client_first_name);
      expect(out).not.toContain(row.input.client_last_name);
      expect(out).not.toContain(row.input.household_name!);
      expect(out).not.toContain(String(row.input.amount));
    }
    // …while the SF ids and stage counts ARE there.
    expect(out).toContain("FIX-0005");
    expect(out).toMatch(/Total rows:\s+8/);
    expect(out).toContain("POTENTIAL 2 / COMMITTED 1 / FUNDING 1 / WON 2 / LOST 2");
  });
});

describe("DEMO dataset + generator round trip (the dress-rehearsal guarantee)", () => {
  const inputs = demoDealInputs();

  it("holds the TDD §7 shape: 24 rows, 6/3/1/10/4, 2 unassigned LOST, 2 prospect rows", () => {
    expect(inputs).toHaveLength(24);
    const byStage = Object.fromEntries(DEAL_STAGES.map((s) => [s, 0])) as Record<string, number>;
    for (const d of inputs) byStage[d.stage] += 1;
    expect(byStage).toEqual({ POTENTIAL: 6, COMMITTED: 3, FUNDING: 1, WON: 10, LOST: 4 });
    const unassigned = inputs.filter((d) => d.owner_name == null);
    expect(unassigned).toHaveLength(2);
    for (const d of unassigned) expect(d.stage).toBe("LOST");
    expect(inputs.filter((d) => d.cedar_ridge_user_id == null)).toHaveLength(2);
  });

  it("uses unique DEMO- sf ids and every row passes the frozen validateDealInput", () => {
    const ids = inputs.map((d) => d.sf_deal_id!);
    expect(new Set(ids).size).toBe(24);
    for (const id of ids) expect(id.startsWith(DEMO_SF_ID_PREFIX)).toBe(true);
    for (const d of inputs) expect(validateDealInput(d)).toEqual({ ok: true, errors: [] });
  });

  it("every demo deal name parses at high confidence (the parseable convention)", () => {
    for (const d of inputs) {
      expect(parseDealName(d.name).confidence).toBe("high");
    }
  });

  it("round-trips: generated CSV → recordsFromCsv → mapReportRow === the source inputs", () => {
    const rows = recordsFromCsv(demoDealCsvText());
    expect(rows).toHaveLength(24);
    const mapped = rows.map((r) => mapReportRow(r).input);
    expect(mapped).toEqual(inputs);
    for (const m of mapped) expect(validateDealInput(m).ok).toBe(true);
  });

  it("dealInputToDbData coerces dates and nulls for the upsert payload", () => {
    const data = dealInputToDbData(inputs[0]);
    expect(data.created_date).toBeInstanceOf(Date);
    expect(data.close_date).toBeInstanceOf(Date);
    expect(data.last_activity_date).toBeNull();
    expect(data.sf_deal_id).toBe("DEMO-0001");
    const unassigned = dealInputToDbData(inputs.find((d) => d.owner_name == null)!);
    expect(unassigned.owner_name).toBeNull();
    expect(unassigned.owner_sf_user_id).toBeNull();
  });

  it("does NOT write asset_mapped — the ingest upsert must never clobber the ops-owned flag (S1 write-isolation)", () => {
    // asset_mapped is toggle-only (setDealAssetMapped). The ingest persistence
    // payload must omit it entirely so a sync leaves the stored value untouched
    // (Prisma writes only listed fields). Regression guard for the clobber the
    // blueprint review caught.
    const data = dealInputToDbData(inputs[0]) as Record<string, unknown>;
    expect(data).not.toHaveProperty("asset_mapped");
  });
});

describe("parseStage — TKT relabel vocabulary + enum keys", () => {
  it("maps the new display labels (case-insensitive) to enum keys", () => {
    expect(parseStage("Potential")).toBe("POTENTIAL");
    expect(parseStage("Potential-Committed")).toBe("COMMITTED");
    expect(parseStage("Potential-In Process")).toBe("FUNDING");
    expect(parseStage("Funded")).toBe("WON");
    expect(parseStage("Lost")).toBe("LOST");
    // Case/whitespace tolerance.
    expect(parseStage("  potential-in process  ")).toBe("FUNDING");
    expect(parseStage("FUNDED")).toBe("WON");
  });

  it("still maps the raw enum keys (what the app CSV export emits)", () => {
    for (const s of DEAL_STAGES) expect(parseStage(s)).toBe(s);
    expect(parseStage("won")).toBe("WON");
  });

  it("passes unknown values through for validateDealInput to flag", () => {
    expect(parseStage("Nope")).toBe("NOPE");
    expect(parseStage("")).toBe("");
  });
});

describe("reportRecordFromObject — n8n row object → ReportRecord → DealInput", () => {
  // A raw CRM report row keyed by the report's CSV column headers (the
  // REPORT_HEADERS canonical aliases), exactly as n8n's extractFromFile emits.
  // INVENTED data (PII rule).
  const rawRow: Record<string, unknown> = {
    "Deal: ID": "SF-DEAL-42",
    "Deal: Deal Name": "Example Client - Fidelity - Roth IRA - 5678",
    "Person: First Name": "Example",
    "Person: Last Name": "Client",
    AUM: "$1,250,000.50",
    "AoA - New Stage": "Funded",
    "Deal: Created Date": "6/15/2026",
    // A column the mapping should ignore (no matching FieldKey alias).
    "Some Unmapped Column": "ignored",
  };

  it("resolves headers via the shared alias resolution (trim/case-insensitive)", () => {
    const record = reportRecordFromObject({
      "  deal: id  ": "SF-1", // padded + lower-case alias still resolves
      "AoA - New Stage": "Potential",
    });
    expect(record.sfDealId).toBe("SF-1");
    expect(record.stage).toBe("Potential");
  });

  it("maps a raw row → DealInput (source IMPORT, stage label→enum, numeric amount)", () => {
    const input = mapReportRow(reportRecordFromObject(rawRow)).input;
    expect(input.source).toBe("IMPORT");
    expect(input.sf_deal_id).toBe("SF-DEAL-42");
    expect(input.stage).toBe("WON"); // "Funded" label → WON
    expect(input.amount).toBe(1250000.5); // "$1,250,000.50" → number
    expect(typeof input.amount).toBe("number");
    expect(input.created_date).toBe("2026-06-15"); // Excel M/D/Y → ISO
    expect(validateDealInput(input).ok).toBe(true);
  });

  it("only sets FieldKeys for columns actually present (absent columns → undefined)", () => {
    const input = mapReportRow(reportRecordFromObject(rawRow)).input;
    // No "Funding Type" column in the row → the D8 explicit-column signal stays
    // undefined, so old-format mapping behaviour is preserved.
    expect(input.employer).toBeUndefined();
    expect(input.rolling_into).toBeUndefined();
  });

  it("a row missing the deal-id column maps to a blank sf_deal_id (→ rejected downstream)", () => {
    const Bartell = { ...rawRow };
    delete Bartell["Deal: ID"];
    const input = mapReportRow(reportRecordFromObject(Bartell)).input;
    expect(input.sf_deal_id).toBeNull();
    // source=IMPORT with a blank sf_deal_id fails the shared contract, which is
    // exactly what the endpoint's per-item guard rejects.
    expect(validateDealInput(input).ok).toBe(false);
  });

  // The ACTUAL CRM "Deals" report row shape (keys = the real CSV headers).
  // The AoA stage rides a column literally named "Stage" (no "AoA - New Stage"),
  // and the owner columns are Salesforce hyperlink artifacts. INVENTED ids/name.
  const reportRow: Record<string, unknown> = {
    "Deal: ID": "a08M830819qPTbGIAW",
    "Deal: Deal Name": "Abdiel Bayer - individual - ICT",
    "Person: First Name": "Abdiel",
    "Person: Last Name": "Bayer",
    AUM: "1410000.00",
    "Deal: Created Date": "1/27/2026",
    Stage: "Funded",
    "Person: Entity Owner":
      "_HL_ENCODED_/005Mm70605CY8mt_HL_Rachel Moss_HL__blank_HL_",
    "Person: Secondary Owner": "Brandy Schaden",
  };

  it("maps the report's 'Stage' column (no 'AoA - New Stage') → enum, and validates end-to-end", () => {
    const record = reportRecordFromObject(reportRow);
    expect(record.stage).toBe("Funded"); // resolved via the secondary "Stage" alias
    const { input } = mapReportRow(record);
    expect(input.stage).toBe("WON"); // "Funded" → WON
    expect(input.stage_raw).toBe("Funded"); // "Stage" also feeds stage_raw provenance
    expect(validateDealInput(input).ok).toBe(true);
  });

  it("de-encodes the Salesforce hyperlink owner artifact → plain name + id", () => {
    const { input } = mapReportRow(reportRecordFromObject(reportRow));
    expect(input.owner_name).toBe("Rachel Moss");
    expect(input.owner_sf_user_id).toBe("005Mm70605CY8mt");
    expect(input.secondary_owner).toBe("Brandy Schaden"); // plain text no-ops
  });

  it("prefers an explicit 'AoA - New Stage' column over 'Stage' (D4 backward-compat)", () => {
    const record = reportRecordFromObject({
      ...reportRow,
      "AoA - New Stage": "Potential",
      Stage: "Funded",
    });
    expect(record.stage).toBe("Potential"); // canonical alias wins
    expect(mapReportRow(record).input.stage).toBe("POTENTIAL");
  });

  it("coerces NON-string JSON cells: numeric AUM + boolean Statements/Plaid Linked", () => {
    // n8n's extractFromFile can hand back JSON numbers/booleans (not just
    // strings) — the reason reportRecordFromObject exists. Exercise that path:
    // AUM as a number, the two boolean-ish columns as actual booleans.
    const input = mapReportRow(
      reportRecordFromObject({
        ...rawRow,
        AUM: 100000, // JSON number, not "100000"
        Statements: false, // JSON boolean, not "no"
        "Plaid Linked": true, // JSON boolean, not "yes"
      }),
    ).input;
    expect(input.amount).toBe(100000);
    expect(typeof input.amount).toBe("number");
    expect(input.statements).toBe(false); // String(false) → "false" → false
    expect(input.plaid_linked).toBe(true); // String(true) → "true" → true
    // The whole coerced row still satisfies the frozen contract.
    expect(validateDealInput(input).ok).toBe(true);
  });
});

describe("client_sf_id — Person: Contact ID → app.deal.client_sf_id (tkt-deals-client-link)", () => {
  // The CRM deals report carries the individual client's 18-char SF
  // Contact id in "Person: Contact ID"; it matches mirror.client.sf_id directly
  // (same width) so the Portrait can show a client's own deals. INVENTED id.
  const CONTACT_ID = "003Qr98551SGEdWIAX"; // 18-char 003 Contact id

  const base: Record<string, unknown> = {
    "Deal: ID": "SF-DEAL-77",
    "Deal: Deal Name": "Example Client - Fidelity - Roth IRA - 5678",
    "Person: First Name": "Example",
    "Person: Last Name": "Client",
    AUM: "500000",
    "AoA - New Stage": "Potential",
    "Deal: Created Date": "6/15/2026",
  };

  it("maps a row WITH Person: Contact ID → client_sf_id set (stored as-is, 18-char)", () => {
    const input = mapReportRow(
      reportRecordFromObject({ ...base, "Person: Contact ID": CONTACT_ID }),
    ).input;
    expect(input.client_sf_id).toBe(CONTACT_ID);
    // Carried onto the upsert payload for both create AND update.
    expect(dealInputToDbData(input).client_sf_id).toBe(CONTACT_ID);
    expect(validateDealInput(input).ok).toBe(true);
  });

  it("maps a row WITHOUT the column → client_sf_id null (still a valid row)", () => {
    const input = mapReportRow(reportRecordFromObject(base)).input;
    expect(input.client_sf_id).toBeNull();
    expect(dealInputToDbData(input).client_sf_id).toBeNull();
    expect(validateDealInput(input).ok).toBe(true);
  });

  it("resolves the header via the CSV path too (trim/case-insensitive)", () => {
    const text = toCsv([
      ["Deal: ID", "Deal: Deal Name", "Person: First Name", "Person: Last Name", "AUM", "AoA - New Stage", "Deal: Created Date", "person: contact id"],
      ["SF-DEAL-77", "Example Client - Fidelity - Roth IRA - 5678", "Example", "Client", "500000", "Potential", "2026-06-15", CONTACT_ID],
    ]);
    const [rec] = recordsFromCsv(text);
    expect(rec.clientSfId).toBe(CONTACT_ID);
    expect(mapReportRow(rec).input.client_sf_id).toBe(CONTACT_ID);
  });
});

describe("deHyperlink — Salesforce owner hyperlink artifact de-encode", () => {
  it("splits the _HL_ENCODED_ form into display name + SF id", () => {
    expect(
      deHyperlink("_HL_ENCODED_/005Mm70605CY8mt_HL_Rachel Moss_HL__blank_HL_"),
    ).toEqual({ name: "Rachel Moss", id: "005Mm70605CY8mt" });
  });

  it("passes a plain name (no _HL_ marker) through UNCHANGED", () => {
    expect(deHyperlink("Brandy Schaden")).toEqual({
      name: "Brandy Schaden",
      id: null,
    });
    // Surrounding whitespace is trimmed but the name is otherwise verbatim.
    expect(deHyperlink("  Brandy Schaden  ")).toEqual({
      name: "Brandy Schaden",
      id: null,
    });
  });

  it("maps null / undefined / blank → both null", () => {
    expect(deHyperlink(null)).toEqual({ name: null, id: null });
    expect(deHyperlink(undefined)).toEqual({ name: null, id: null });
    expect(deHyperlink("   ")).toEqual({ name: null, id: null });
  });
});
