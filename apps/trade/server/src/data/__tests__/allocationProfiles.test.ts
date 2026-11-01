import { describe, it, expect } from 'vitest';
import { getProfile } from '../allocationProfiles.js';

describe('getProfile', () => {
  it('throws on NaN riskLevel', () => {
    expect(() => getProfile('nationalTaxEfficient', NaN)).toThrow('Invalid risk level');
  });

  it('throws on Infinity riskLevel', () => {
    expect(() => getProfile('nationalTaxEfficient', Infinity)).toThrow('Invalid risk level');
  });

  it('returns a valid profile for level 1', () => {
    const profile = getProfile('nationalTaxEfficient', 1);
    expect(profile).toBeDefined();
    expect(profile.positions.length).toBeGreaterThan(0);
  });

  it('returns a valid profile for level 25', () => {
    const profile = getProfile('nationalTaxEfficient', 25);
    expect(profile).toBeDefined();
    expect(profile.positions.length).toBeGreaterThan(0);
  });

  it('clamps below 1 and above 25', () => {
    const low = getProfile('nationalTaxEfficient', 0);
    const first = getProfile('nationalTaxEfficient', 1);
    expect(low).toEqual(first);

    const high = getProfile('nationalTaxEfficient', 100);
    const last = getProfile('nationalTaxEfficient', 25);
    expect(high).toEqual(last);
  });
});
