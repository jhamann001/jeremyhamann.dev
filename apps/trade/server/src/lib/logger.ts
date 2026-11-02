import pino from 'pino';

/**
 * Request serializer that strips the query string from access logs. Query
 * params can carry client identifiers — the /api/machine endpoint keys on
 * ?cedar_ridge_user_id=… — which must never land in logs (the counts-only, no-id
 * PII discipline the machine handler itself follows). Wraps pino's standard req
 * serializer so every other field (method, headers, remote address) is
 * preserved; only the URL's query segment is dropped. Exported for testing.
 */
export function stripQueryFromReq(request: Parameters<typeof pino.stdSerializers.req>[0]) {
  const serialized = pino.stdSerializers.req(request);
  if (typeof serialized.url === 'string') {
    const q = serialized.url.indexOf('?');
    if (q !== -1) serialized.url = serialized.url.slice(0, q);
  }
  const maybeQuery = serialized as { query?: unknown };
  if (maybeQuery.query !== undefined) maybeQuery.query = undefined;
  return serialized;
}

/**
 * Paths censored in every log line. pino-http logs request headers on every
 * request, so any header that carries a credential or a person's identity must
 * be listed: the advisor platform actor assertion carries the person's email, name and role.
 * Exported for testing.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-ops-portal-actor-assertion"]',
  'req.headers["x-demo-reset-token"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'email',
  'password',
  'ssn',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
];

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: {
    req: stripQueryFromReq,
  },
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty' },
  }),
});

export default logger;
