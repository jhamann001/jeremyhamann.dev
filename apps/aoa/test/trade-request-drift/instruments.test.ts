import { describe, it, expect, vi } from 'vitest';
import {
  CASH_SYMBOLS,
  FIXED_INCOME_SYMBOLS,
  classifySymbol,
  classifyTemplateConstituent,
  isCashEquivalentSymbol,
  isDerivedMoneyMarketFund,
} from '@/lib/trade-requests/sources/data/instruments';

describe('classifySymbol', () => {
  describe('Drift Detection Additions (ticket)', () => {
    it.each(['BND', 'SGOV', 'SCMB', 'PZA', 'ITM'])('classifies %s as fixed', (symbol) => {
      expect(classifySymbol(symbol)).toBe('fixed');
    });

    it('classifies SWKXX as cash', () => {
      expect(classifySymbol('SWKXX')).toBe('cash');
    });

    it('places SWKXX in CASH_SYMBOLS via MONEY_MARKET_PATTERN', () => {
      expect(CASH_SYMBOLS.has('SWKXX')).toBe(true);
    });

    it('places BND in FIXED_INCOME_SYMBOLS', () => {
      expect(FIXED_INCOME_SYMBOLS.has('BND')).toBe(true);
    });
  });

  describe('Cash-equiv broaden — drift v2 R1 resolution', () => {
    it.each(['VMFXX', 'VMRXX', 'FZFXX', 'SPAXX', 'SPRXX', 'FDRXX'])('classifies %s as cash', (symbol) => {
      expect(classifySymbol(symbol)).toBe('cash');
    });

    it.each(['VMFXX', 'VMRXX', 'FZFXX', 'SPAXX', 'SPRXX', 'FDRXX'])(
      'places %s in CASH_SYMBOLS via MONEY_MARKET_PATTERN',
      (symbol) => {
        expect(CASH_SYMBOLS.has(symbol)).toBe(true);
      },
    );

    it('does NOT place any new symbol in FIXED_INCOME_SYMBOLS', () => {
      for (const symbol of ['VMFXX', 'VMRXX', 'FZFXX', 'SPAXX', 'SPRXX', 'FDRXX']) {
        expect(FIXED_INCOME_SYMBOLS.has(symbol)).toBe(false);
      }
    });

    it('keeps the safety-net regex working for an unadded MMF (FDLXX)', () => {
      // FDLXX is a real Fidelity MMF that this PR intentionally did NOT add to INSTRUMENTS.
      // It must still classify as 'equity' (the gated `drift_suspected_cash_equiv_misclassified`
      // warn log in positionDriftAccounts.ts:§4.3 step 10 is the operator's safety net).
      expect(classifySymbol('FDLXX')).toBe('equity');
    });
  });

  describe('Cash-equiv broaden — drift v2 R2 production safety-net hits', () => {
    it.each(['PCOXX', 'BUPXX', 'GMMXX'])('classifies %s as cash', (symbol) => {
      expect(classifySymbol(symbol)).toBe('cash');
    });

    it.each(['PCOXX', 'BUPXX', 'GMMXX'])('places %s in CASH_SYMBOLS via MONEY_MARKET_PATTERN', (symbol) => {
      expect(CASH_SYMBOLS.has(symbol)).toBe(true);
    });

    it('does NOT place any R2 symbol in FIXED_INCOME_SYMBOLS', () => {
      for (const symbol of ['PCOXX', 'BUPXX', 'GMMXX']) {
        expect(FIXED_INCOME_SYMBOLS.has(symbol)).toBe(false);
      }
    });
  });

  describe('cash-like fallbacks (regression guard for instruments.ts:92)', () => {
    it.each(['CASH', 'USD', ''])('classifies %j as cash', (symbol) => {
      expect(classifySymbol(symbol)).toBe('cash');
    });
  });

  describe('equity fallback (regression guard for instruments.ts:95)', () => {
    it('classifies an unknown ticker (AAPL) as equity', () => {
      expect(classifySymbol('AAPL')).toBe('equity');
    });
  });

  describe('input normalization (regression guard for instruments.ts:90)', () => {
    it('trims and uppercases the symbol before lookup', () => {
      expect(classifySymbol('  bnd  ')).toBe('fixed');
    });
  });

  describe('Meridian templates spot-check (2026-Q3 cutover)', () => {
    // Spot-check the IndividualSecurity tickers that appear in the actual
    // 2026-05-15 templates export. The full list ran via `jq` against the
    // source file before the loader was wired in (see plan §8 Verified
    // preconditions).
    it.each(['AGG', 'BND', 'SHYG', 'VCSH', 'VGSH', 'SGOV', 'SCMB', 'PZA', 'ITM', 'MUB', 'VTEB', 'SUB'])(
      'classifies fixed-income template ticker %s as fixed',
      (symbol) => {
        expect(classifySymbol(symbol)).toBe('fixed');
      },
    );

    it.each(['SWVXX', 'VMSXX', 'VUSXX', 'VYFXX'])('classifies money-market template ticker %s as cash', (symbol) => {
      expect(classifySymbol(symbol)).toBe('cash');
    });

    it.each(['VTI', 'SPY', 'VXUS'])('classifies equity template ticker %s as equity', (symbol) => {
      expect(classifySymbol(symbol)).toBe('equity');
    });
  });
});

describe('classifyTemplateConstituent (2026-Q3 cutover decision #7)', () => {
  it('routes IndividualSecurity tickers through classifySymbol (cash path)', () => {
    expect(classifyTemplateConstituent({ security: 'VMFXX', securityType: 'IndividualSecurity' })).toBe('cash');
  });

  it('routes IndividualSecurity tickers through classifySymbol (fixed path)', () => {
    expect(classifyTemplateConstituent({ security: 'AGG', securityType: 'IndividualSecurity' })).toBe('fixed');
  });

  it('routes IndividualSecurity tickers through classifySymbol (equity fallback)', () => {
    expect(classifyTemplateConstituent({ security: 'VOO', securityType: 'IndividualSecurity' })).toBe('equity');
  });

  it('routes My Firm opaque IDs to equity unconditionally', () => {
    expect(classifyTemplateConstituent({ security: 'DDnHo3QE52MbAd3RTDrU2G', securityType: 'My Firm' })).toBe('equity');
  });

  it('routes Personal opaque IDs to equity unconditionally', () => {
    expect(classifyTemplateConstituent({ security: 'o7sDE87Xyghi5Hy7weSYDC', securityType: 'Personal' })).toBe(
      'equity',
    );
  });

  it('treats undefined securityType as IndividualSecurity (defensive forward-compat)', () => {
    expect(classifyTemplateConstituent({ security: 'BND' })).toBe('fixed');
    expect(classifyTemplateConstituent({ security: 'AAPL' })).toBe('equity');
  });

  it('defaults to equity AND emits a warn log when an unknown securityType is encountered', () => {
    const warnLogger = { warn: vi.fn() };
    expect(classifyTemplateConstituent({ security: 'opaque-id', securityType: 'Institutional' }, warnLogger)).toBe(
      'equity',
    );
    expect(warnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'drift_template_unknown_security_type',
        security: 'opaque-id',
        securityType: 'Institutional',
      }),
      expect.any(String),
    );
  });
});

describe('isDerivedMoneyMarketFund', () => {
  // The 8 MMFs actually held in apex_daily_stock_record over the 90 days to
  // 2026-08-17. Every one priced at exactly 1.00 on every day of that window.
  it.each(['SWVXX', 'VMSXX', 'VYFXX', 'VCTXX', 'VMFXX', 'BUPXX', 'PCOXX', 'GMMXX'])(
    'identifies %s from asset_type + $1.00 NAV',
    (symbol) => {
      expect(isDerivedMoneyMarketFund({ assetType: 'MUTUAL_FUND', closingPrice: 1, symbolDescription: symbol })).toBe(
        true,
      );
    },
  );

  it('identifies an MMF absent from the curated list — the self-maintaining case', () => {
    // A ticker CASH_SYMBOLS has never heard of. classifySymbol would default it
    // to equity and trip drift_suspected_cash_equiv_misclassified in prod.
    expect(classifySymbol('XYZXX')).toBe('equity');
    expect(
      isCashEquivalentSymbol('XYZXX', {
        assetType: 'MUTUAL_FUND',
        closingPrice: 1,
        symbolDescription: 'SOME NEW GOVT MONEY MKT FD',
      }),
    ).toBe(true);
  });

  it('catches a fund that breaks the buck via its name', () => {
    expect(
      isDerivedMoneyMarketFund({
        assetType: 'MUTUAL_FUND',
        closingPrice: 0.9994,
        symbolDescription: 'VANGUARD MUNI MONEY MKT FD',
      }),
    ).toBe(true);
  });

  it('does NOT match an ordinary stock trading at exactly $1.00', () => {
    expect(
      isDerivedMoneyMarketFund({ assetType: 'EQUITY', closingPrice: 1, symbolDescription: 'PENNY CORP COM' }),
    ).toBe(false);
  });

  it('does NOT match a long mutual fund', () => {
    // VCAIX — a real holding, $11.42 NAV, muni bond fund not a money fund.
    expect(
      isDerivedMoneyMarketFund({
        assetType: 'MUTUAL_FUND',
        closingPrice: 11.42,
        symbolDescription: 'VANGUARD CA INTER TERM TAXEXEMPT FD INV SHS',
      }),
    ).toBe(false);
  });

  it('does NOT match an equity whose name happens to contain a keyword', () => {
    expect(
      isDerivedMoneyMarketFund({
        assetType: 'EQUITY',
        closingPrice: 42,
        symbolDescription: 'LIQUIDITY SERVICES INC COM',
      }),
    ).toBe(false);
  });

  it('tolerates missing columns', () => {
    expect(isDerivedMoneyMarketFund({})).toBe(false);
    expect(isDerivedMoneyMarketFund({ assetType: null, closingPrice: null, symbolDescription: null })).toBe(false);
  });
});

describe('isCashEquivalentSymbol', () => {
  it('honors the curated list with no feed metadata', () => {
    expect(isCashEquivalentSymbol('SWVXX')).toBe(true);
    expect(isCashEquivalentSymbol('NVDA')).toBe(false);
  });

  it('is promote-only — never demotes a curated cash symbol', () => {
    // Feed metadata says "not an MMF"; the curated list still wins.
    expect(isCashEquivalentSymbol('SWVXX', { assetType: 'EQUITY', closingPrice: 250 })).toBe(true);
  });

  it('does not promote a curated fixed-income symbol to cash', () => {
    expect(isCashEquivalentSymbol('BND', { assetType: 'EQUITY', closingPrice: 72 })).toBe(false);
  });
});
