import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  formTitleVersion,
  routeLabel,
  signatureBlocks,
  titlesSectionComplete,
} from "@/lib/transfers/route-label";

const SUITE = "asset-transfer-route-label";

describe("asset transfer route labels", () => {
  it("full-acat-app-authorization", () => {
    expect(routeLabel("ACAT_FULL", true)).toBe("Full ACAT · app authorization · Apex API");
    markCase(SUITE, "full-acat-app-authorization");
  });

  it("full-acat-signed-paperwork", () => {
    expect(routeLabel("ACAT_FULL", false)).toBe("Full ACAT · signed paperwork · Apex API");
    markCase(SUITE, "full-acat-signed-paperwork");
  });

  it("partial-acat", () => {
    expect(routeLabel("ACAT_PARTIAL", false)).toBe("Partial ACAT · signed paperwork · Ascend entry");
    markCase(SUITE, "partial-acat");
  });

  it("drs", () => {
    expect(routeLabel("DRS", false)).toBe("DRS · Apex service request");
    markCase(SUITE, "drs");
  });

  it("manual", () => {
    expect(routeLabel("MANUAL", false)).toBe("Manual · custodian-library process");
    markCase(SUITE, "manual");
  });

  it("check", () => {
    expect(routeLabel("CHECK", false)).toBe("Rollover · physical check");
    markCase(SUITE, "check");
  });

  it("ach", () => {
    expect(routeLabel("ACH", false)).toBe("ACH · client self-service");
    markCase(SUITE, "ach");
  });

  it("wire", () => {
    expect(routeLabel("WIRE", false)).toBe("Wire · client instructions");
    markCase(SUITE, "wire");
  });

  it("signature-full-acat-app-authorization", () => {
    expect(signatureBlocks("Full ACAT · app authorization · Apex API", false)).toBe(false);
    expect(signatureBlocks("Full ACAT · app authorization · Apex API", true)).toBe(false);
    markCase(SUITE, "signature-full-acat-app-authorization");
  });

  it("signature-full-acat-signed-paperwork", () => {
    expect(signatureBlocks("Full ACAT · signed paperwork · Apex API", false)).toBe(true);
    expect(signatureBlocks("Full ACAT · signed paperwork · Apex API", true)).toBe(false);
    markCase(SUITE, "signature-full-acat-signed-paperwork");
  });

  it("signature-partial-acat", () => {
    expect(signatureBlocks("Partial ACAT · signed paperwork · Ascend entry", false)).toBe(true);
    expect(signatureBlocks("Partial ACAT · signed paperwork · Ascend entry", true)).toBe(false);
    markCase(SUITE, "signature-partial-acat");
  });

  it("signature-drs", () => {
    expect(signatureBlocks("DRS · Apex service request", false)).toBe(true);
    expect(signatureBlocks("DRS · Apex service request", true)).toBe(false);
    markCase(SUITE, "signature-drs");
  });

  it("signature-manual", () => {
    expect(signatureBlocks("Manual · custodian-library process", false)).toBe(true);
    expect(signatureBlocks("Manual · custodian-library process", true)).toBe(false);
    markCase(SUITE, "signature-manual");
  });

  it("signature-check", () => {
    expect(signatureBlocks("Rollover · physical check", false)).toBe(false);
    expect(signatureBlocks("Rollover · physical check", true)).toBe(false);
    markCase(SUITE, "signature-check");
  });

  it("signature-ach", () => {
    expect(signatureBlocks("ACH · client self-service", false)).toBe(false);
    expect(signatureBlocks("ACH · client self-service", true)).toBe(false);
    markCase(SUITE, "signature-ach");
  });

  it("signature-wire", () => {
    expect(signatureBlocks("Wire · client instructions", false)).toBe(false);
    expect(signatureBlocks("Wire · client instructions", true)).toBe(false);
    markCase(SUITE, "signature-wire");
  });

  it("titles-complete", () => {
    expect(titlesSectionComplete({
      receivingFormTitle: " TEST RECEIVING ",
      sourceFormTitle: "TEST SOURCE",
      titleOwnersConfirmed: null,
      receivingAccountTitle: "TEST RECEIVING",
      sourceAccountTitle: "TEST SOURCE",
    })).toBe(true);
    expect(titlesSectionComplete({
      receivingFormTitle: " TEST RECEIVING ",
      sourceFormTitle: "TEST SOURCE",
      titleOwnersConfirmed: formTitleVersion("TEST RECEIVING", "TEST SOURCE"),
      receivingAccountTitle: "TEST RECEIVING ACCOUNT",
      sourceAccountTitle: "TEST SOURCE",
    })).toBe(true);
    markCase(SUITE, "titles-complete");
  });

  it("titles-incomplete", () => {
    const changed = {
      receivingFormTitle: "TEST RECEIVING",
      sourceFormTitle: "TEST SOURCE",
      receivingAccountTitle: "TEST RECEIVING ACCOUNT",
      sourceAccountTitle: "TEST SOURCE",
    };
    expect(titlesSectionComplete({ ...changed, titleOwnersConfirmed: formTitleVersion("TEST OLDER", "TEST SOURCE") })).toBe(false);
    expect(titlesSectionComplete({ ...changed, titleOwnersConfirmed: null })).toBe(false);
    expect(titlesSectionComplete({
      receivingFormTitle: "TEST RECEIVING",
      sourceFormTitle: "TEST SOURCE",
      titleOwnersConfirmed: null,
      receivingAccountTitle: null,
      sourceAccountTitle: null,
    })).toBe(false);
    expect(titlesSectionComplete({
      receivingFormTitle: "  ",
      sourceFormTitle: "TEST SOURCE",
      titleOwnersConfirmed: formTitleVersion("  ", "TEST SOURCE"),
      receivingAccountTitle: "  ",
      sourceAccountTitle: "TEST SOURCE",
    })).toBe(false);
    expect(titlesSectionComplete({
      receivingFormTitle: null,
      sourceFormTitle: null,
      titleOwnersConfirmed: null,
      receivingAccountTitle: null,
      sourceAccountTitle: null,
    })).toBe(false);
    markCase(SUITE, "titles-incomplete");
  });
});
