import { describe, it, expect } from 'vitest';
import { stripQueryFromReq } from '../logger.js';

// Pins the machine-endpoint PII fix: the request serializer must keep query
// strings — which carry cedar_ridge_user_id(s) on /api/machine — OUT of access
// logs, while preserving the rest of the request line.
describe('stripQueryFromReq — access-log query redaction', () => {
  function fakeReq(url: string) {
    // Minimal shape pino.stdSerializers.req consumes.
    return {
      method: 'GET',
      url,
      headers: { host: 'trade-request.example' },
      socket: { remoteAddress: '10.0.0.1', remotePort: 443 },
    } as unknown as Parameters<typeof stripQueryFromReq>[0];
  }

  it('drops the cedar_ridge_user_id query on the machine route', () => {
    const out = stripQueryFromReq(
      fakeReq('/api/machine/trade-requests?cedar_ridge_user_id=user-ae66b3c8-d257-4a6a-a8fd-d1c3641db27b'),
    );
    expect(out.url).toBe('/api/machine/trade-requests');
    expect(JSON.stringify(out)).not.toContain('user-ae66b3c8');
    expect(JSON.stringify(out)).not.toContain('cedar_ridge_user_id');
  });

  it('drops a batch cedar_ridge_user_ids list too', () => {
    const out = stripQueryFromReq(fakeReq('/api/machine/trade-requests?cedar_ridge_user_ids=user-aaa,user-bbb'));
    expect(out.url).toBe('/api/machine/trade-requests');
    expect(JSON.stringify(out)).not.toContain('user-aaa');
  });

  it('leaves a query-less url untouched', () => {
    const out = stripQueryFromReq(fakeReq('/api/health'));
    expect(out.url).toBe('/api/health');
  });

  it('preserves method + host on the serialized line', () => {
    const out = stripQueryFromReq(fakeReq('/api/machine/trade-requests?cedar_ridge_user_id=user-x'));
    expect(out.method).toBe('GET');
    // The standard serializer keeps headers.host — confirm we didn't strip the rest.
    expect(JSON.stringify(out)).toContain('trade-request.example');
  });
});

// pino-http logs every request's headers. The advisor platform actor assertion carries the
// person's email, name and role, so it must be censored like Authorization
// (TRW-01, contract item 8: no PII in logs).
describe('REDACT_PATHS — access-log header redaction', () => {
  it('censors the advisor platform actor assertion and bearer token in a real pino-http access log', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: pino } = await import('pino');
    const { default: pinoHttp } = await import('pino-http');
    const { REDACT_PATHS } = await import('../logger.js');

    const lines: string[] = [];
    const stream = { write: (line: string) => lines.push(line) };
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
    const app = express();
    app.use(pinoHttp({ logger: log }));
    app.get('/api/ops-portal/requests', (_req, res) => res.json({ ok: true }));

    // Built at runtime so secret scanners don't mistake a test value for a real token.
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const assertion = [b64({ alg: 'RS256' }), b64({ sub: 'pat.synthetic@example.com' }), 'fake-signature'].join('.');
    await request(app)
      .get('/api/ops-portal/requests')
      .set('Authorization', 'Bearer app-id-token-value')
      .set('X-OPS-PORTAL-Actor-Assertion', assertion);

    const output = lines.join('\n');
    expect(output).toContain('request completed');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(assertion);
    expect(output).not.toContain('app-id-token-value');
  });

  it('censors the demo reset token and the stand-in API key', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: pino } = await import('pino');
    const { default: pinoHttp } = await import('pino-http');
    const { REDACT_PATHS } = await import('../logger.js');

    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, { write: (line: string) => lines.push(line) });
    const app = express();
    app.use(pinoHttp({ logger: log }));
    app.post('/api/internal/demo-reset', (_req, res) => res.json({ ok: true }));

    const resetToken = ['reset', 'token', 'value'].join('-');
    const apiKey = ['stand', 'in', 'key'].join('-');
    await request(app).post('/api/internal/demo-reset').set('x-demo-reset-token', resetToken).set('x-api-key', apiKey);

    const output = lines.join('\n');
    expect(output).toContain('request completed');
    expect(output).not.toContain(resetToken);
    expect(output).not.toContain(apiKey);
  });
});
