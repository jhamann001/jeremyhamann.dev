import { GoogleAuth } from "google-auth-library";

// Machine-authenticated calls from AOA's cutover controller (ticket) to the standalone Trade Request service:
// GET/PUT /api/machine/service-mode (ticket) and GET /api/machine/engine-use (ticket). The ID token is
// minted keylessly from the ambient identity with the service base URL as audience, as lib/data/trade-requests.ts
// does. Never log the token, the URL or a response body; errors carry a static code only.

export type StandaloneMode = "active" | "frozen" | "mcp-only";
export type SenderSwitch = "on" | "off";

export type StandaloneState = {
  mode: StandaloneMode;
  persistedMode: StandaloneMode;
  override: StandaloneMode | null;
  digestSender: SenderSwitch;
  driftSender: SenderSwitch;
  modeChangedAt: string | null;
  writesSettledAt: string | null;
};

export type StandaloneChange = { mode?: StandaloneMode; digestSender?: SenderSwitch; driftSender?: SenderSwitch };

export type EngineUseCounts = { ran: number; refused: number };
export type EngineUseDay = { day: string; mcp: EngineUseCounts; service: EngineUseCounts };
export type EngineUseReport = {
  planGeneration: "on" | "off";
  windowDays: number;
  coveredDays: number;
  countingStarted: string | null;
  planGenerationOffSince: string | null;
  days: EngineUseDay[];
  today: EngineUseDay;
};

export interface StandaloneControl {
  readState(): Promise<StandaloneState>;
  changeState(change: StandaloneChange, reason: string): Promise<StandaloneState>;
  readEngineUse(days: number): Promise<EngineUseReport>;
}

export type MachineResponse = { status: number; data: unknown };
export type MachineTransport = (request: { method: "GET" | "PUT"; path: string; body?: unknown }) => Promise<MachineResponse>;

export class StandaloneUnavailable extends Error {
  constructor(readonly code: string) {
    super(`standalone service unavailable: ${code}`);
  }
}

export const STANDALONE_TIMEOUT_MS = 15_000;
const MODES: readonly StandaloneMode[] = ["active", "frozen", "mcp-only"];
const SWITCHES: readonly SenderSwitch[] = ["on", "off"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is StandaloneMode => MODES.includes(v as StandaloneMode);
const isSwitch = (v: unknown): v is SenderSwitch => SWITCHES.includes(v as SenderSwitch);
const isTime = (v: unknown): v is string | null => v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isCounts = (v: unknown): v is EngineUseCounts => isRecord(v) && isCount(v.ran) && isCount(v.refused);
const isDay = (v: unknown): v is EngineUseDay =>
  isRecord(v) && typeof v.day === "string" && isCounts(v.mcp) && isCounts(v.service);

export function parseStandaloneState(data: unknown): StandaloneState {
  if (
    !isRecord(data) ||
    !isMode(data.mode) ||
    !isMode(data.persistedMode) ||
    !(data.override === null || isMode(data.override)) ||
    !isSwitch(data.digestSender) ||
    !isSwitch(data.driftSender) ||
    !isTime(data.modeChangedAt) ||
    !isTime(data.writesSettledAt)
  ) {
    throw new StandaloneUnavailable("malformed_service_mode");
  }
  return {
    mode: data.mode,
    persistedMode: data.persistedMode,
    override: data.override,
    digestSender: data.digestSender,
    driftSender: data.driftSender,
    modeChangedAt: data.modeChangedAt,
    writesSettledAt: data.writesSettledAt,
  };
}

export function parseEngineUse(data: unknown): EngineUseReport {
  if (
    !isRecord(data) ||
    (data.planGeneration !== "on" && data.planGeneration !== "off") ||
    !isCount(data.windowDays) ||
    !isCount(data.coveredDays) ||
    !(data.countingStarted === null || typeof data.countingStarted === "string") ||
    !(data.planGenerationOffSince === null || typeof data.planGenerationOffSince === "string") ||
    !Array.isArray(data.days) ||
    !data.days.every(isDay) ||
    !isDay(data.today)
  ) {
    throw new StandaloneUnavailable("malformed_engine_use");
  }
  return {
    planGeneration: data.planGeneration,
    windowDays: data.windowDays,
    coveredDays: data.coveredDays,
    countingStarted: data.countingStarted,
    planGenerationOffSince: data.planGenerationOffSince,
    days: data.days,
    today: data.today,
  };
}

export function createStandaloneControl(transport: MachineTransport): StandaloneControl {
  async function call(method: "GET" | "PUT", path: string, body?: unknown): Promise<unknown> {
    let res: MachineResponse;
    try {
      res = await transport({ method, path, body });
    } catch {
      throw new StandaloneUnavailable("transport_error");
    }
    if (res.status !== 200) throw new StandaloneUnavailable(`status_${res.status}`);
    return res.data;
  }
  return {
    async readState() {
      return parseStandaloneState(await call("GET", "/api/machine/service-mode"));
    },
    async changeState(change, reason) {
      return parseStandaloneState(await call("PUT", "/api/machine/service-mode", { ...change, reason }));
    },
    async readEngineUse(days) {
      return parseEngineUse(await call("GET", `/api/machine/engine-use?days=${days}`));
    },
  };
}

/** The production transport: keyless ID token with audience = the service base URL, no retry, 15 s budget. */
export function googleTransport(baseUrl: string): MachineTransport {
  const base = baseUrl.replace(/\/+$/, "");
  const auth = new GoogleAuth();
  return async ({ method, path, body }) => {
    const client = await auth.getIdTokenClient(base);
    const res = await client.request({
      url: `${base}${path}`,
      method,
      data: body,
      timeout: STANDALONE_TIMEOUT_MS,
      retry: false,
      validateStatus: () => true,
    });
    return { status: res.status, data: res.data };
  };
}
