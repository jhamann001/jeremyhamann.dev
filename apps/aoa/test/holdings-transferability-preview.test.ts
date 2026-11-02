import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const requests: Array<{ audience: string; url: string; method: string; data: unknown; timeout: number }> = [];

vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getIdTokenClient(audience: string) {
      return {
        request: async (options: { url: string; method: string; data: unknown; timeout: number }) => {
          requests.push({ audience, ...options });
          return {
            status: 200,
            data: {
              rules_status: "ok",
              rows: [{ label: "likely_transferable", reason: "omni" }],
            },
          };
        },
      };
    }
  },
}));

import {
  annotationsFromClassifier,
  classifyHoldingsTransferability,
  classifierRequestBody,
  HOLDINGS_TRANSFERABILITY_PATH,
  HOLDINGS_TRANSFERABILITY_TIMEOUT_MS,
} from "@/lib/data/holdings-transferability-preview";
import { classificationInputsFromCard } from "@/lib/data/linked-external-holdings-preview";

const INPUTS = [
  { symbol: "FGHIJ", name: "Growth Fund", security_type: "mutual fund" },
];

describe("holdings transferability preview client", () => {
  afterEach(() => {
    requests.length = 0;
    vi.unstubAllEnvs();
  });

  it("posts only the symbol, name, and security_type allowlist to the read-only route", async () => {
    vi.stubEnv("STATEMENT_PIPELINE_URL", "https://pipeline.example/");
    const result = await classifyHoldingsTransferability([
      { ...INPUTS[0], cusip: "037833100", isin: "US0000000001", access_token: "secret", cost_basis: 4 } as never,
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].audience).toBe("https://pipeline.example");
    expect(requests[0].url).toBe(`https://pipeline.example${HOLDINGS_TRANSFERABILITY_PATH}`);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].timeout).toBe(HOLDINGS_TRANSFERABILITY_TIMEOUT_MS);
    expect(requests[0].data).toEqual({
      rows: [{ symbol: "FGHIJ", name: "Growth Fund", security_type: "mutual fund" }],
    });
    expect(JSON.stringify(requests[0].data)).not.toMatch(/cusip|isin|access_token|cost_basis/i);
    expect(result).toEqual([{ label: "likely_transferable", reason: "omni" }]);
    markCase("holdings-transferability-preview", "posts only the symbol, name, and security_type allowlist to the read-only route");
  });

  it("maps Omni, non-Omni, and unlisted labels and drops a reason that is not a known code", () => {
    expect(annotationsFromClassifier({
      rules_status: "ok",
      rows: [
        { label: "likely_transferable", reason: "omni" },
        { label: "unknown", reason: "mutual_fund_non_omni" },
        { label: "unknown", reason: "mutual_fund_unlisted" },
        { label: "likely_not", reason: "fixed_income" },
        { label: "likely_transferable", reason: "FGHIJ" },
      ],
    }, 5)).toEqual([
      { label: "likely_transferable", reason: "omni" },
      { label: "unknown", reason: "mutual_fund_non_omni" },
      { label: "unknown", reason: "mutual_fund_unlisted" },
      { label: "likely_not", reason: "fixed_income" },
      { label: "unknown", reason: "rules_unavailable" },
    ]);
    markCase("holdings-transferability-preview", "maps Omni, non-Omni, and unlisted labels and drops a reason that is not a known code");
  });

  it("marks every row unknown when the classifier is unavailable or times out", async () => {
    vi.stubEnv("STATEMENT_PIPELINE_URL", "https://pipeline.example");
    expect(annotationsFromClassifier({ rules_status: "unavailable", rows: [] }, 2)).toEqual([
      { label: "unknown", reason: "rules_unavailable" },
      { label: "unknown", reason: "rules_unavailable" },
    ]);

    const timedOut = await classifyHoldingsTransferability(INPUTS, {
      timeoutMs: 20,
      request: (_url, _body, timeoutMs) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ECONNABORTED" })), timeoutMs);
      }),
    });
    expect(timedOut).toEqual([{ label: "unknown", reason: "rules_unavailable" }]);
    markCase("holdings-transferability-preview", "marks every row unknown when the classifier is unavailable or times out");
  });

  it("keeps security_type for the classifier and out of the browser row shape", () => {
    const inputs = classificationInputsFromCard([
      {
        ticker: "FGHIJ",
        security_name: "Growth Fund",
        security_type: "mutual fund",
        quantity: 1,
        market_value: 10,
        cusip: "037833100",
        isin: "US0000000001",
        access_token: "secret",
        cost_basis: 4,
      },
    ]);
    expect(inputs).toEqual(INPUTS);
    expect(classifierRequestBody(inputs).rows[0]).not.toHaveProperty("cusip");
    const source = readFileSync("lib/data/holdings-transferability-preview.ts", "utf8");
    expect(source).not.toMatch(/write_household|asset-map|account-aum|prisma|writeAum|client_account_aum/);
    const action = readFileSync("app/(authenticated)/client-portrait/[id]/actions.ts", "utf8");
    const preview = action.slice(action.indexOf("export async function previewLinkedHoldings"));
    expect(preview).not.toMatch(/apexAccountsForClient|fetchHouseholdsPage|writeAudit|withUserScope/);
    markCase("holdings-transferability-preview", "keeps security_type for the classifier and out of the browser row shape");
  });
});
