import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Prisma } from "@prisma/client";
import { markCase } from "./acat-book-flywheel";
import {
  MAILING_JOURNEYS,
  journeyLegs,
  mailingReportRow,
  mailingStatus,
  saveMailing,
  updateMailingLegs,
  validateMailingLegs,
} from "@/lib/transfers/mailing";
import { MailingReportTable } from "@/components/asset-transfer/mailing/MailingReportRows";

const SUITE = "asset-transfer-mailing";
const IDENTITY = { role: "CLIENT_SERVICE", email: "cs@example.test" };

function fakeTx() {
  const touched: string[] = [];
  const mailingCreate = vi.fn(async () => ({ id: "mail-1" }));
  const mailingFind = vi.fn(async () => ({ id: "mail-1", journey: "Cedar Ridge to the client to the final destination" }) as { id: string; journey: string } | null);
  const legUpsert = vi.fn(async () => ({}));
  const auditCreate = vi.fn(async () => ({}));
  const models: Record<string, unknown> = {
    transferMailing: { create: mailingCreate, findFirst: mailingFind },
    transferMailingLeg: { upsert: legUpsert },
    auditLog: { create: auditCreate },
  };
  const tx = new Proxy(models, {
    get(target, key: string) {
      touched.push(key);
      return target[key] ?? { create: vi.fn(), update: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() };
    },
  }) as unknown as Prisma.TransactionClient;
  return { tx, touched, mailingCreate, mailingFind, legUpsert, auditCreate };
}

const SOURCE = {
  id: "mail-1",
  transfer_id: "transfer-42",
  reason: "Wet signature required",
  contents: "TOA form, statement copy",
  journey: "Cedar Ridge to the client to Cedar Ridge to the final destination",
  postage: 12.5,
  created_at: new Date("2026-10-20T15:00:00Z"),
  transfer: {
    client_first_name: "Test",
    client_last_name: "Client",
    asset_map_custodian: "Schwab",
    asset_map_account_type: "Roth IRA",
    asset_map_account_number: "TEST00001234",
    accounts: [{ label: "Cedar Ridge Roth IRA" }],
  },
};

describe("asset transfer mailing", () => {
  it("refuse-missing-journey", async () => {
    const { tx, mailingCreate } = fakeTx();
    const result = await saveMailing(tx, IDENTITY, "transfer-42", { reason: "Wet Signature", contents: ["Signed transfer paperwork"], contentsNote: "", journey: "", postage: "" }, true);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((e) => e.field)).toContain("journey");
    const other = await saveMailing(tx, IDENTITY, "transfer-42", { reason: "Wet Signature", contents: ["Signed transfer paperwork"], contentsNote: "", journey: "By courier", postage: "" }, true);
    expect(other.ok).toBe(false);
    expect(mailingCreate).not.toHaveBeenCalled();
    markCase(SUITE, "refuse-missing-journey");
  });

  it("save-one-of-four-journeys", async () => {
    expect(MAILING_JOURNEYS).toHaveLength(4);
    for (const journey of MAILING_JOURNEYS) {
      const { tx, mailingCreate } = fakeTx();
      const result = await saveMailing(tx, IDENTITY, "transfer-42", { reason: "Wet Signature", contents: ["Signed transfer paperwork"], contentsNote: "", journey, postage: "4.10" }, true);
      expect(result).toEqual({ ok: true, id: "mail-1" });
      expect(mailingCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          transfer_id: "transfer-42", reason: "Wet Signature", contents: "Signed transfer paperwork",
          content_items: ["Signed transfer paperwork"], contents_note: null, journey, postage: 4.1,
        }),
        select: { id: true },
      });
    }
    markCase(SUITE, "save-one-of-four-journeys");
  });

  it("report-row-fields", () => {
    const row = mailingReportRow(SOURCE);
    expect(row.client).toBe("Test Client");
    expect(row.sourceAccount).toBe("Schwab · Roth IRA · ••1234");
    expect(row.receivingAccount).toBe("Cedar Ridge Roth IRA");
    expect(row.contents).toBe("TOA form, statement copy");
    expect(row.legs.map((leg) => leg.label)).toEqual(["Cedar Ridge → the client", "The client → Cedar Ridge", "Cedar Ridge → the final destination"]);
    expect(row.status).toBe("Not yet mailed");
    expect(journeyLegs("Cedar Ridge to the client")).toEqual(["Cedar Ridge → the client"]);
    expect(row.postage).toBe("$12.50");
    const html = renderToStaticMarkup(createElement(MailingReportTable, { rows: [row] }));
    for (const text of ["Test Client", "Schwab · Roth IRA · ••1234", "Cedar Ridge Roth IRA", "TOA form, statement copy", "The client → Cedar Ridge", "$12.50", "Download CSV"]) {
      expect(html).toContain(text);
    }
    markCase(SUITE, "report-row-fields");
  });

  it("open-row-opens-movement", () => {
    const row = mailingReportRow(SOURCE);
    expect(row.href).toBe("/asset-transfer/transfer-42");
    const html = renderToStaticMarkup(createElement(MailingReportTable, { rows: [row] }));
    expect(html).toContain('href="/asset-transfer/transfer-42?from=mailing"');
    markCase(SUITE, "open-row-opens-movement");
  });

  it("save-does-not-write-other-tables", async () => {
    const { tx, touched, mailingCreate, auditCreate } = fakeTx();
    await saveMailing(tx, IDENTITY, "transfer-42", { reason: "Wet Signature", contents: ["Signed transfer paperwork"], contentsNote: "", journey: MAILING_JOURNEYS[0], postage: "" }, true);
    expect(mailingCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect([...new Set(touched)].sort()).toEqual(["auditLog", "transferMailing"]);
    markCase(SUITE, "save-does-not-write-other-tables");
  });

  it("saves-carrier-tracking-and-dates-per-leg", async () => {
    const { tx, mailingCreate, auditCreate } = fakeTx();
    const result = await saveMailing(tx, IDENTITY, "transfer-42", {
      reason: "Wet Signature", contents: ["Signed transfer paperwork"], contentsNote: "", journey: "Cedar Ridge to the client to the final destination", postage: "",
      legs: [
        { carrier: "FedEx", trackingNumber: "TEST-TRACK-1", mailedOn: "2026-10-14", receivedOn: "2026-10-16" },
        { carrier: "USPS", trackingNumber: "", mailedOn: "2026-10-18", receivedOn: "" },
      ],
    }, true);
    expect(result).toEqual({ ok: true, id: "mail-1" });
    expect(mailingCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ legs: { create: [
        { leg_number: 1, from_stop: "Cedar Ridge", to_stop: "the client", carrier: "FedEx", tracking_number: "TEST-TRACK-1",
          mailed_on: new Date("2026-10-14T00:00:00.000Z"), received_on: new Date("2026-10-16T00:00:00.000Z") },
        { leg_number: 2, from_stop: "the client", to_stop: "the final destination", carrier: "USPS", tracking_number: null,
          mailed_on: new Date("2026-10-18T00:00:00.000Z"), received_on: null },
      ] } }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ detail: expect.not.objectContaining({ trackingNumber: expect.anything() }) }),
    }));
    markCase(SUITE, "saves-carrier-tracking-and-dates-per-leg");
  });

  it("refuses-inconsistent-leg-dates", () => {
    const journey = "Cedar Ridge to the client to the final destination";
    const leg = { carrier: "FedEx", trackingNumber: "", mailedOn: "2026-10-14", receivedOn: "" };
    const today = "2026-10-21";
    const fails = (legs: typeof leg[]) => {
      const result = validateMailingLegs(journey, legs, today);
      return result.ok ? [] : result.errors.map((error) => error.message);
    };
    expect(fails([{ ...leg, carrier: "Pigeon" }])[0]).toContain("choose FedEx");
    expect(fails([{ ...leg, mailedOn: "", receivedOn: "2026-10-15" }])[0]).toContain("mailed date before the received date");
    expect(fails([{ ...leg, receivedOn: "2026-10-13" }])[0]).toContain("cannot precede");
    expect(fails([{ ...leg, mailedOn: "2026-10-22" }])[0]).toContain("future");
    expect(fails([{ ...leg, receivedOn: "2026-10-16" }, { ...leg, mailedOn: "2026-10-15" }])[0]).toContain("previous leg was received");
    expect(fails([leg, leg, leg])[0]).toContain("fewer legs");
    expect(validateMailingLegs(journey, [leg], today).ok).toBe(true);
    markCase(SUITE, "refuses-inconsistent-leg-dates");
  });

  it("status-follows-the-latest-leg", () => {
    const base = { number: 1, label: "", from: "Cedar Ridge", to: "the client", carrier: null, trackingNumber: null, mailedOn: null, receivedOn: null };
    const back = { ...base, number: 2, from: "the client", to: "Cedar Ridge" };
    expect(mailingStatus([base, back])).toBe("Not yet mailed");
    expect(mailingStatus([{ ...base, mailedOn: "2026-10-14" }, back])).toBe("In transit to the client");
    expect(mailingStatus([{ ...base, mailedOn: "2026-10-14", receivedOn: "2026-10-15" }, back])).toBe("Received by client");
    expect(mailingStatus([{ ...base, mailedOn: "2026-10-14", receivedOn: "2026-10-15" }, { ...back, mailedOn: "2026-10-16", receivedOn: "2026-10-18" }]))
      .toBe("Returned to Cedar Ridge");
    markCase(SUITE, "status-follows-the-latest-leg");
  });

  it("updates-legs-of-a-saved-mailing", async () => {
    const { tx, legUpsert, auditCreate, mailingFind } = fakeTx();
    const result = await updateMailingLegs(tx, IDENTITY, "transfer-42", "mail-1", [
      { carrier: "UPS", trackingNumber: "TEST-TRACK-2", mailedOn: "2026-10-14", receivedOn: "" },
    ], true, "2026-10-21");
    expect(result).toEqual({ ok: true, id: "mail-1" });
    expect(legUpsert).toHaveBeenCalledTimes(2);
    expect(legUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { mailing_id_leg_number: { mailing_id: "mail-1", leg_number: 1 } },
      update: expect.objectContaining({ carrier: "UPS", tracking_number: "TEST-TRACK-2" }),
    }));
    expect(auditCreate).toHaveBeenCalledTimes(1);
    mailingFind.mockResolvedValueOnce(null);
    const missing = await updateMailingLegs(tx, IDENTITY, "transfer-42", "mail-other", [], true, "2026-10-21");
    expect(missing.ok).toBe(false);
    const off = await updateMailingLegs(tx, IDENTITY, "transfer-42", "mail-1", [], false);
    expect(off.ok).toBe(false);
    markCase(SUITE, "updates-legs-of-a-saved-mailing");
  });
});
