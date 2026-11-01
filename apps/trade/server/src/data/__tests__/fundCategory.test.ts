import { describe, it, expect } from 'vitest';
import { classifyFundCategory, bucketForAssetClass } from '../fundCategory.js';

describe('classifyFundCategory', () => {
  it('routes fixed-income categories to bond asset classes (before equity)', () => {
    expect(classifyFundCategory('Intermediate Government')).toBe('US Bond');
    expect(classifyFundCategory('Intermediate Core Bond')).toBe('US Bond');
    expect(classifyFundCategory('Long Government')).toBe('US Bond');
    expect(classifyFundCategory('High Yield Bond')).toBe('High Yield Bond');
    expect(classifyFundCategory('Muni National Interm')).toBe('Muni Bond');
    expect(classifyFundCategory('Global Bond')).toBe('Global Bond');
    expect(classifyFundCategory('Ultrashort Bond')).toBe('Short-Term Bond');
  });

  it('does not let "Emerging Markets Bond" fall into EM Equity', () => {
    expect(classifyFundCategory('Emerging Markets Bond')).toBe('Global Bond');
    expect(classifyFundCategory('Emerging-Markets Local-Currency Bond')).toBe('Global Bond');
  });

  it('classifies money market as cash-bucket', () => {
    expect(classifyFundCategory('Money Market - Taxable')).toBe('Money Market');
    expect(bucketForAssetClass('Money Market')).toBe('cash');
  });

  it('classifies international vs emerging vs US equity', () => {
    expect(classifyFundCategory('Foreign Large Blend')).toBe('Intl Equity');
    expect(classifyFundCategory('Europe Stock')).toBe('Intl Equity');
    expect(classifyFundCategory('Diversified Emerging Mkts')).toBe('EM Equity');
    expect(classifyFundCategory('Large Value')).toBe('US Equity');
    expect(classifyFundCategory('Mid-Cap Blend')).toBe('US Equity');
    expect(classifyFundCategory('Large Blend')).toBe('US Equity');
  });

  it('classifies sector + thematic equity funds', () => {
    expect(classifyFundCategory('Technology')).toBe('Sector Equity');
    expect(classifyFundCategory('Natural Resources')).toBe('Sector Equity');
    expect(classifyFundCategory('Consumer Cyclical')).toBe('Sector Equity');
  });

  it('handles commodity, real estate, allocation', () => {
    expect(classifyFundCategory('Commodities Broad Basket')).toBe('Commodity');
    expect(classifyFundCategory('Real Estate')).toBe('Real Estate');
    expect(classifyFundCategory('Target-Date 2060+')).toBe('Allocation');
  });

  it('maps asset classes to the correct drift bucket', () => {
    expect(bucketForAssetClass('US Bond')).toBe('fixed');
    expect(bucketForAssetClass('Muni Bond')).toBe('fixed');
    expect(bucketForAssetClass('Intl Equity')).toBe('equity');
    expect(bucketForAssetClass('Real Estate')).toBe('equity');
  });

  it('returns null for empty/unknown input', () => {
    expect(classifyFundCategory(null)).toBeNull();
    expect(classifyFundCategory('')).toBeNull();
    expect(classifyFundCategory('   ')).toBeNull();
    expect(classifyFundCategory('Something Totally Novel')).toBeNull();
  });
});
