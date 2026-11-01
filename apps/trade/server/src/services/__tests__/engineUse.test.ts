import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPool, loggerMock, engineMock } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn(), end: vi.fn() },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  engineMock: {
    runAssetLocationEngine: vi.fn(() => ({ plans: [], validation: { passed: true, issues: [], tolerances: {} } })),
    verifyExecutionPlans: vi.fn(() => ({ passed: true, issues: [], tolerances: {} })),
  },
}));

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));
vi.mock('../assetLocationEngine.js', () => engineMock);

import {
  planGenerationEnabled,
  engineUseDay,
  flushEngineUse,
  runEngine,
  verifyStoredPlans,
  engineUseReport,
  startEngineUseCounting,
  EngineRefusedError,
  EngineUseUnavailableError,
} from '../engineUse.js';

const input = {} as Parameters<typeof runEngine>[1];
const verifyArgs: Parameters<typeof verifyStoredPlans> extends [unknown, ...infer Rest] ? Rest : never = [
  [],
  { grandTotal: 0, baseAllocation: { cash: 0, fixed: 0, equity: 0 }, isDepositOnly: false },
];

beforeEach(async () => {
  delete process.env.EXECUTION_PLAN_GENERATION;
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  await flushEngineUse();
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
  loggerMock.error.mockReset();
  engineMock.runAssetLocationEngine.mockClear();
  engineMock.verifyExecutionPlans.mockClear();
});

afterEach(() => {
  delete process.env.EXECUTION_PLAN_GENERATION;
});

describe('planGenerationEnabled', () => {
  it('is on when the variable is unset', () => {
    expect(planGenerationEnabled()).toBe(true);
  });

  it('is off when the variable is "off"', () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    expect(planGenerationEnabled()).toBe(false);
  });
});

describe('runEngine', () => {
  it('runs a service call while on, buffering the count until a flush', async () => {
    await runEngine('service', input);
    expect(engineMock.runAssetLocationEngine).toHaveBeenCalledTimes(1);
    expect(mockPool.query).not.toHaveBeenCalled();

    await flushEngineUse();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][1]).toEqual([engineUseDay(), 'service', 'ran', 1]);
  });

  it('refuses a service call while off and writes the refusal before throwing', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    const err = await runEngine('service', input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRefusedError);
    expect((err as EngineRefusedError).statusCode).toBe(409);
    expect(engineMock.runAssetLocationEngine).not.toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][1]).toEqual([engineUseDay(), 'service', 'refused', 1]);
  });

  it('runs an MCP call while off and buffers its count', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    await runEngine('mcp', input);
    expect(engineMock.runAssetLocationEngine).toHaveBeenCalledTimes(1);
    expect(mockPool.query).not.toHaveBeenCalled();

    await flushEngineUse();
    expect(mockPool.query.mock.calls[0][1]).toEqual([engineUseDay(), 'mcp', 'ran', 1]);
  });
});

describe('verifyStoredPlans', () => {
  it('skips the verifier for a service caller while off and counts nothing', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    expect(verifyStoredPlans('service', ...verifyArgs)).toBeUndefined();
    expect(engineMock.verifyExecutionPlans).not.toHaveBeenCalled();
    await flushEngineUse();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('aggregates MCP verifier calls into one upsert', async () => {
    verifyStoredPlans('mcp', ...verifyArgs);
    verifyStoredPlans('mcp', ...verifyArgs);
    verifyStoredPlans('mcp', ...verifyArgs);
    await flushEngineUse();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][1]).toEqual([engineUseDay(), 'mcp', 'ran', 3]);
  });
});

describe('write failures', () => {
  it('answers 503 when a refusal cannot be written, without running the engine or buffering', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    const err = await runEngine('service', input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUseUnavailableError);
    expect((err as EngineUseUnavailableError).statusCode).toBe(503);
    expect(engineMock.runAssetLocationEngine).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'engine_use_count_failed' }),
      expect.any(String),
    );

    mockPool.query.mockClear();
    await flushEngineUse();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('fails the report with 503 when buffered counts cannot be written', async () => {
    verifyStoredPlans('mcp', ...verifyArgs);
    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    const err = await engineUseReport(7).catch((e: unknown) => e);
    expect((err as { statusCode: number }).statusCode).toBe(503);
  });
});

describe('engineUseReport', () => {
  const now = new Date('2026-10-28T15:00:00Z');

  function queueReport(): void {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ counting_started: '2026-10-15', off_since: '2026-10-23' }] })
      .mockResolvedValueOnce({
        rows: [
          { day: '2026-10-27', caller_class: 'service', outcome: 'refused', count: 2 },
          { day: '2026-10-28', caller_class: 'mcp', outcome: 'ran', count: 5 },
        ],
      });
  }

  it('counts only complete days after the counting start and the switch-off date', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    queueReport();
    const report = await engineUseReport(7, now);
    expect(report.days.map((d) => d.day)).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(report.coveredDays).toBe(4);
    expect(report.days[6].service.refused).toBe(2);
    expect(report.today.mcp.ran).toBe(5);
    expect(report.planGeneration).toBe('off');
  });

  it('covers no days while plan generation is on', async () => {
    queueReport();
    const report = await engineUseReport(7, now);
    expect(report.coveredDays).toBe(0);
    expect(report.planGeneration).toBe('on');
  });
});

describe('startEngineUseCounting', () => {
  const now = new Date('2026-10-28T15:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the counting start and the switch-off date while off', async () => {
    process.env.EXECUTION_PLAN_GENERATION = 'off';
    await startEngineUseCounting(now);
    const [insert, update] = mockPool.query.mock.calls;
    expect(String(insert[0])).toContain('INSERT INTO engine_use_meta');
    expect(insert[1]).toEqual(['2026-10-28']);
    expect(String(update[0])).toContain('COALESCE(plan_generation_off_since');
    expect(update[1]).toEqual(['2026-10-28']);
  });

  it('starts the periodic flush even when the first start-up write fails', async () => {
    vi.resetModules();
    const fresh = await import('../engineUse.js');
    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(fresh.startEngineUseCounting(now)).rejects.toThrow('db down');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears the switch-off date while on', async () => {
    await startEngineUseCounting(now);
    const [, update] = mockPool.query.mock.calls;
    expect(String(update[0])).toContain('plan_generation_off_since = NULL');
  });
});
