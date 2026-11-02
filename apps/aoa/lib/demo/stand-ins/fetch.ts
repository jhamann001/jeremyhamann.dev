import { demoMode } from "../mode";

// The demo's outside services, answered inside the app. A service client builds its real request (Google's request
// pipeline for the Transfer Tracker and the statement pipeline, plain fetch for the warehouse); in the demo the
// network call comes here instead, matched by the service's origin (its *_URL setting) and route. A route with no
// stand-in answers 501, which every caller already treats as the service being down. Trade Requests need none: the
// demo serves them from the app's own backend. Server code only; the stand-ins load on first use, in the demo.

export type StandInService = "tracker" | "pipeline" | "warehouse";

const SERVICE_SETTING: Record<StandInService, string> = {
  tracker: "TRANSFER_TRACKER_URL",
  pipeline: "STATEMENT_PIPELINE_URL",
  warehouse: "WAREHOUSE_URL",
};

export interface StandInCall {
  method: string;
  url: URL;
  /** The route's `:name` segments. */
  params: Record<string, string>;
  /** The JSON body, or null. */
  body: unknown;
  headers: Headers;
}

export interface StandInReply {
  status: number;
  json?: unknown;
  bytes?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
}

export type StandInRoute = readonly [method: string, pattern: string, answer: (call: StandInCall) => Promise<StandInReply>];

const ROUTES: Record<StandInService, () => Promise<readonly StandInRoute[]>> = {
  tracker: async () => (await import("./tracker")).TRACKER_ROUTES,
  pipeline: async () => (await import("./pipeline")).PIPELINE_ROUTES,
  warehouse: async () => (await import("./warehouse")).WAREHOUSE_ROUTES,
};

const LOG_TAG = "demo-stand-in";

function serviceFor(origin: string): StandInService | null {
  for (const [service, setting] of Object.entries(SERVICE_SETTING) as [StandInService, string][]) {
    const value = process.env[setting];
    if (value && URL.canParse(value) && new URL(value).origin === origin) return service;
  }
  return null;
}

/** The route's parameters when `pathname` matches `pattern`, else null. Throws URIError for a parameter that isn't
 * valid percent-encoding. */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = pathname.replace(/\/+$/, "").split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      if (!got[i]) return null;
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

function reply({ status, json, bytes, headers }: StandInReply): Response {
  if (bytes) return new Response(bytes, { status, headers });
  if (json === undefined) return new Response(null, { status, headers });
  return Response.json(json, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A fetch that never leaves the process: the demo's stand-ins answer it. Refuses outside the demo. */
export async function standInFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!demoMode()) throw new Error("stand_in_outside_demo");
  const request = new Request(input, init);
  const url = new URL(request.url);
  const service = serviceFor(url.origin);
  if (!service) {
    console.error(`[${LOG_TAG}] no_service`);
    return reply({ status: 501, json: { error: "not_in_demo" } });
  }
  for (const [method, pattern, answer] of await ROUTES[service]()) {
    if (method !== request.method) continue;
    let params: Record<string, string> | null;
    try {
      params = matchRoute(pattern, url.pathname);
    } catch (error) {
      // A path segment that isn't valid percent-encoding, so decodeURIComponent throws: the request is malformed,
      // and gets the 400 the real service would give it rather than an error from the stand-in.
      if (!(error instanceof URIError)) throw error;
      console.error(`[${LOG_TAG}] ${service} bad_path ${request.method}`);
      return reply({ status: 400, json: { error: "bad_request" } });
    }
    if (!params) continue;
    return reply(await answer({ method, url, params, body: await readBody(request), headers: request.headers }));
  }
  console.error(`[${LOG_TAG}] ${service} no_route ${request.method}`);
  return reply({ status: 501, json: { error: "not_in_demo" } });
}

/** fetch for calls to an outside service: the stand-ins in the demo, the network otherwise. */
export const serviceFetch: typeof fetch = (input, init) => (demoMode() ? standInFetch(input, init) : fetch(input, init));
