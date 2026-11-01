import { describe, it, expect, vi } from 'vitest';
import { attachDemoFlag } from '../demo.js';

function createReq(sessionDemo?: boolean) {
  return {
    session: sessionDemo !== undefined ? { demo: sessionDemo } : {},
  } as any;
}

describe('attachDemoFlag', () => {
  it('sets isDemo to true when session.demo is true', () => {
    const req = createReq(true);
    const next = vi.fn();
    attachDemoFlag(req, {} as any, next);
    expect(req.isDemo).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets isDemo to false when session.demo is false', () => {
    const req = createReq(false);
    const next = vi.fn();
    attachDemoFlag(req, {} as any, next);
    expect(req.isDemo).toBe(false);
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets isDemo to false when session.demo is undefined', () => {
    const req = createReq();
    const next = vi.fn();
    attachDemoFlag(req, {} as any, next);
    expect(req.isDemo).toBe(false);
    expect(next).toHaveBeenCalledOnce();
  });

  it('sets isDemo to false when session is undefined', () => {
    const req = { session: undefined } as any;
    const next = vi.fn();
    attachDemoFlag(req, {} as any, next);
    expect(req.isDemo).toBe(false);
    expect(next).toHaveBeenCalledOnce();
  });
});
