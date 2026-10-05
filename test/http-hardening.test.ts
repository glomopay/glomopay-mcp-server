import { logRecords, metricExporter, metricReader } from './otel-setup';

import { generateKeyPairSync } from 'node:crypto';
import { connect } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import type { DataPoint } from '@opentelemetry/sdk-metrics';

import { flushApps } from '@/core/app/app.module';
import { shutdownTelemetry } from '@/core/telemetry/telemetry.module';
import {
  callTool,
  captureMixpanel,
  isRefused,
  jwt,
  postRaw,
  signApiKey,
  startBrokenUpstream,
  TEST_AUDIENCE,
  startTestServer,
  type IFakeUpstream,
  type IRawResponse,
  type ITestServer,
  type ITestServerOptions,
} from './helpers';

const MIXPANEL_TOKEN = 'mixpanel-test-project-token';
const MERCHANT_A = 'merch_4f9a8b7c6d5e';
const MERCHANT_B = 'merch_7a1b2c3d4e5f';
const SANDBOX_KEY = jwt('sandbox', { sub: MERCHANT_A });
const MERCHANT_A_KEY = SANDBOX_KEY;
/** A second, distinct credential for the same merchant. */
const MERCHANT_A_SECOND_KEY = jwt('sandbox', { sub: MERCHANT_A, jti: 'second-credential' });
const MERCHANT_B_KEY = jwt('sandbox', { sub: MERCHANT_B });
const GARBAGE_TOKEN = 'not-a-credential';
/** Claims merchant A but is signed with a key the server does not trust. */
const FOREIGN_KEY_CLAIMING_A = signApiKey(
  { sub: MERCHANT_A, env: 'sandbox', aud: TEST_AUDIENCE, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
);
/** Claims merchant A with no signature at all. */
const UNSIGNED_CLAIMING_A = `${MERCHANT_A_KEY.split('.').slice(0, 2).join('.')}.`;

const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const OVERSIZED = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(150 * 1024) } });
const READ_PAYOUT = { operationId: 'getPayoutById', params: { id: 'payout_1' } };

/** No stack frame, file path or exception name: what a leaking error page carries. */
const LEAK = /\bat [\w.<>]+ \(|:\d+:\d+\)|node_modules|\/Users\/|\/home\/|\/app\/|SyntaxError|PayloadTooLargeError|<html/i;

let upstream: IFakeUpstream;
const started: ITestServer[] = [];

async function server(options: ITestServerOptions = {}): Promise<ITestServer> {
  const app = await startTestServer({ apiHost: upstream.origin, env: { MIXPANEL_TOKEN }, ...options });
  started.push(app);
  return app;
}

beforeAll(async () => {
  upstream = await startBrokenUpstream('status', { body: { id: 'payout_1' } });
});

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  logRecords.reset();
});

afterEach(async () => {
  await flushApps();
  await Promise.all(started.splice(0).map((app) => app.close()));
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await upstream.close();
  await shutdownTelemetry();
});

async function rejectedCount(attributes: Record<string, string>): Promise<number> {
  await metricReader.forceFlush();
  const metric = metricExporter
    .getMetrics()
    .at(-1)
    ?.scopeMetrics.flatMap((scope) => scope.metrics)
    .find((entry) => entry.descriptor.name === 'mcp.http.rejected');
  const points = (metric?.dataPoints ?? []) as DataPoint<number>[];
  const match = points.find(
    (point) =>
      Object.keys(point.attributes).length === Object.keys(attributes).length &&
      Object.entries(attributes).every(([key, value]) => point.attributes[key] === value),
  );
  return match?.value ?? 0;
}

function jsonRpcError(response: IRawResponse): { code: number; message: string } {
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  const body = JSON.parse(response.text) as { jsonrpc: string; id: unknown; error: { code: number; message: string; data?: unknown } };
  expect(body.jsonrpc).toBe('2.0');
  expect(body.id).toBeNull();
  expect(body.error).not.toHaveProperty('data');
  expect(response.text).not.toMatch(LEAK);
  return body.error;
}

function from(address: string, chain = ''): Record<string, string> {
  return { 'X-Forwarded-For': chain ? `${chain}, ${address}` : address };
}

/** The chain Render delivers: whatever the client sent, then the client, Cloudflare and an internal proxy. */
function viaRender(client: string, forged?: string): Record<string, string> {
  return { 'X-Forwarded-For': [forged, client, '162.158.0.1', '10.0.0.1'].filter(Boolean).join(', '), 'True-Client-IP': client };
}

async function statuses(count: number, send: (index: number) => Promise<IRawResponse>): Promise<number[]> {
  const result: number[] = [];
  for (let index = 0; index < count; index++) result.push((await send(index)).status);
  return result;
}

/** A POST with neither Content-Length nor Transfer-Encoding, which fetch cannot send. */
function postWithoutBody(url: string): Promise<IRawResponse> {
  const { hostname, port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    let raw = '';
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `POST ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Type: application/json\r\n` +
          'Accept: application/json, text/event-stream\r\nConnection: close\r\n\r\n',
      );
    });
    socket.on('data', (chunk) => (raw += String(chunk)));
    socket.on('error', reject);
    socket.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const [statusLine, ...headerLines] = head.split('\r\n');
      const headers = new Headers(headerLines.map((line) => line.split(/:\s*/, 2) as [string, string]));
      const text = rest.join('\r\n\r\n');
      // The 400 body is small and sent in one chunk; strip chunked framing if present.
      const body = headers.get('transfer-encoding') === 'chunked' ? (text.split('\r\n')[1] ?? '') : text;
      resolve({ status: Number(statusLine.split(' ')[1]), headers, text: body });
    });
  });
}

const toolsList = (app: ITestServer, headers?: Record<string, string>) => postRaw(app.url, TOOLS_LIST, headers);

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const READ_PAYOUT_CALL = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'glomo_api_read', arguments: READ_PAYOUT } });
const readPayout = (app: ITestServer, token: string, headers: Record<string, string> = {}) =>
  postRaw(app.url, READ_PAYOUT_CALL, { ...bearer(token), ...headers });

describe('error responses', () => {
  it('answers malformed JSON with a JSON-RPC parse error and no stack or path', async () => {
    const app = await server();
    const before = await rejectedCount({ reason: 'parse_error' });
    const response = await postRaw(app.url, '{"jsonrpc":');

    expect(response.status).toBe(400);
    expect(jsonRpcError(response)).toEqual({ code: -32700, message: 'Parse error' });
    expect(await rejectedCount({ reason: 'parse_error' })).toBe(before + 1);
  });

  it('answers a body over 100 KB with a JSON 413', async () => {
    const app = await server();
    const before = await rejectedCount({ reason: 'body_too_large' });
    const response = await postRaw(app.url, OVERSIZED);

    expect(response.status).toBe(413);
    expect(jsonRpcError(response)).toEqual({ code: -32000, message: 'Payload Too Large: the request body exceeds 100 KB' });
    expect(await rejectedCount({ reason: 'body_too_large' })).toBe(before + 1);
  });

  for (const contentType of ['application/json-patch+json', 'application/json; charset=utf-8', 'text/plain; profile=application/json']) {
    it(`enforces the body size limit for an accepted Content-Type: ${contentType}`, async () => {
      const app = await server();
      const oversized = await postRaw(app.url, OVERSIZED, { 'Content-Type': contentType });
      const small = await postRaw(app.url, TOOLS_LIST, { 'Content-Type': contentType });

      expect(oversized.status).toBe(413);
      jsonRpcError(oversized);
      expect(small.status).toBe(200);
      expect(small.text).toContain('glomo_api_search');
    });
  }

  it('answers a Content-Type the transport does not accept with a JSON-RPC 415', async () => {
    const app = await server();
    const response = await postRaw(app.url, TOOLS_LIST, { 'Content-Type': 'text/plain' });

    expect(response.status).toBe(415);
    expect(jsonRpcError(response).code).toBe(-32000);
  });

  it('answers an empty body with Invalid Request', async () => {
    const app = await server();
    const response = await postRaw(app.url, '');

    expect(response.status).toBe(400);
    expect(jsonRpcError(response)).toEqual({ code: -32600, message: 'Invalid Request' });
  });

  it('answers a POST that declares no body with a parse error, never reading the stream itself', async () => {
    const app = await server();
    const response = await postWithoutBody(app.url);

    expect(response.status).toBe(400);
    expect(jsonRpcError(response)).toEqual({ code: -32700, message: 'Parse error' });
  });

  for (const [label, body] of [
    ['an object that is not JSON-RPC', '{"a":1}'],
    ['an empty batch', '[]'],
    ['a batch holding a non-message', `[${TOOLS_LIST}, 7]`],
  ]) {
    it(`answers ${label} with Invalid Request and no validation detail`, async () => {
      const app = await server();
      const before = await rejectedCount({ reason: 'invalid_request' });
      const response = await postRaw(app.url, body);

      expect(response.status).toBe(400);
      expect(jsonRpcError(response)).toEqual({ code: -32600, message: 'Invalid Request' });
      expect(await rejectedCount({ reason: 'invalid_request' })).toBe(before + 1);
    });
  }

  it('refuses a batch over 20 messages without running any of them, and serves a batch of 20', async () => {
    const app = await server();
    const mixpanel = captureMixpanel();
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'glomo_api_read', arguments: READ_PAYOUT } });
    const reachedBefore = upstream.requests.length;

    const tooMany = await postRaw(app.url, JSON.stringify(Array.from({ length: 21 }, (_, index) => call(index + 1))), {
      Authorization: `Bearer ${SANDBOX_KEY}`,
    });
    await flushApps();

    expect(tooMany.status).toBe(400);
    expect(jsonRpcError(tooMany)).toEqual({ code: -32600, message: 'Invalid Request: a batch may carry at most 20 messages' });
    expect(upstream.requests.length).toBe(reachedBefore);
    expect(mixpanel.events).toHaveLength(0);

    const twenty = await postRaw(
      app.url,
      JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/list' }))),
    );
    expect(twenty.status).toBe(200);
  });

  it('answers GET and DELETE on /mcp with a JSON-RPC 405 and an unknown path with a JSON 404', async () => {
    const app = await server();
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(app.url, { method });
      expect(response.status).toBe(405);
      expect(jsonRpcError({ status: response.status, headers: response.headers, text: await response.text() }).code).toBe(-32000);
    }
    const missing = await fetch(app.url.replace('/mcp', '/nope'));
    expect(missing.status).toBe(404);
    expect(jsonRpcError({ status: missing.status, headers: missing.headers, text: await missing.text() }).message).toBe('Not Found');
  });

  it('does not announce the framework', async () => {
    const app = await server();
    const responses = [await toolsList(app), await postRaw(app.url, '{'), await fetch(app.url.replace('/mcp', '/healthz'))];
    for (const response of responses) expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('sends no analytics for a request rejected before the transport', async () => {
    const app = await server();
    const mixpanel = captureMixpanel();
    await postRaw(app.url, '{"jsonrpc":');
    await postRaw(app.url, OVERSIZED);
    await postRaw(app.url, '{"a":1}');
    await postRaw(app.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), { 'Content-Type': 'text/plain' });
    await flushApps();

    expect(mixpanel.events).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('answers past the per-address budget with a 429, Retry-After and RateLimit headers', async () => {
    const app = await server({ rateLimit: { perMinute: 3 } });
    const before = await rejectedCount({ reason: 'rate_limited', limiter: 'caller' });

    expect(await statuses(3, () => toolsList(app))).toEqual([200, 200, 200]);
    const limited = await toolsList(app);

    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get('ratelimit')).toContain('"caller"');
    expect(limited.headers.get('ratelimit-policy')).toContain('q=3; w=60');
    expect(jsonRpcError(limited)).toEqual({ code: -32000, message: `Too Many Requests: retry after ${retryAfter} seconds` });
    expect(await rejectedCount({ reason: 'rate_limited', limiter: 'caller' })).toBe(before + 1);
  });

  it('caps every address with the flood guard in front, verified merchants included', async () => {
    const app = await server({ rateLimit: { floodPerMinute: 3, merchantPerMinute: 100 } });
    const before = await rejectedCount({ reason: 'rate_limited', limiter: 'flood' });

    expect(await statuses(3, () => toolsList(app, bearer(MERCHANT_A_KEY)))).toEqual([200, 200, 200]);
    const limited = await toolsList(app, bearer(MERCHANT_B_KEY));

    expect(limited.status).toBe(429);
    expect(limited.headers.get('ratelimit')).toContain('"flood"');
    expect(await rejectedCount({ reason: 'rate_limited', limiter: 'flood' })).toBe(before + 1);
  });

  it('counts malformed and oversized bodies against the flood guard', async () => {
    const app = await server({ rateLimit: { floodPerMinute: 2 } });
    await postRaw(app.url, '{"jsonrpc":');
    await postRaw(app.url, OVERSIZED);

    expect((await toolsList(app)).status).toBe(429);
  });

  it('never limits the health check', async () => {
    const app = await server({ rateLimit: { floodPerMinute: 1, perMinute: 1 } });
    const health = app.url.replace('/mcp', '/healthz');

    expect(await statuses(5, () => fetch(health).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() })))).toEqual(
      Array(5).fill(200),
    );
  });

  it('gives execution calls their own, smaller budget while discovery keeps working', async () => {
    const app = await server({ rateLimit: { executionPerMinute: 2 } });
    const before = await rejectedCount({ reason: 'rate_limited', limiter: 'execution' });

    for (let i = 0; i < 2; i++) expect((await readPayout(app, MERCHANT_A_KEY)).status).toBe(200);
    const limited = await readPayout(app, MERCHANT_A_KEY);

    expect(limited.status).toBe(429);
    expect(limited.headers.get('ratelimit')).toContain('"execution"');
    expect(isRefused(await callTool(app.url, 'glomo_api_search', { query: 'payout' }, MERCHANT_A_KEY))).toBe(false);
    expect(await rejectedCount({ reason: 'rate_limited', limiter: 'execution' })).toBe(before + 1);
  });

  it('records no tool event and makes no upstream call for a rate-limited tools/call', async () => {
    const app = await server({ rateLimit: { merchantPerMinute: 2 } });
    const mixpanel = captureMixpanel();
    const reachedBefore = upstream.requests.length;

    expect(await statuses(4, () => readPayout(app, MERCHANT_A_KEY))).toEqual([200, 200, 429, 429]);
    await flushApps();

    expect(upstream.requests.length).toBe(reachedBefore + 2);
    const submitted = mixpanel.events.filter((event) => event.event === 'mcp_tool_submitted');
    expect(submitted).toHaveLength(2);
    expect(submitted.every((event) => event.properties.status === 'success')).toBe(true);
    expect(mixpanel.events.filter((event) => event.event === 'mcp_tool_failed')).toHaveLength(0);
  });

  it('gives configured shared-egress ranges the larger budget', async () => {
    const app = await server({
      trustProxyHops: 1,
      rateLimit: { perMinute: 3, sharedEgressCidrs: ['198.51.100.0/24'], sharedEgressPerMinute: 6 },
    });

    expect(await statuses(7, () => toolsList(app, from('198.51.100.7')))).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(await statuses(4, () => toolsList(app, from('192.0.2.7')))).toEqual([200, 200, 200, 429]);
  });

  it("treats Anthropic's published egress ranges as shared by default, with budgets from env", async () => {
    const app = await server({
      trustProxyHops: 1,
      rateLimit: {},
      env: { MIXPANEL_TOKEN, RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_SHARED_EGRESS_PER_MINUTE: '4', RATE_LIMIT_SHARED_EGRESS_CIDRS: undefined },
    });

    expect(await statuses(5, () => toolsList(app, from('160.79.104.10')))).toEqual([200, 200, 200, 200, 429]);
    expect(await statuses(5, () => toolsList(app, from('2607:6bc0::10')))).toEqual([200, 200, 200, 200, 429]);
    expect(await statuses(3, () => toolsList(app, from('192.0.2.7')))).toEqual([200, 200, 429]);
  });

  it('groups IPv6 clients by /56', async () => {
    const app = await server({ trustProxyHops: 1, rateLimit: { perMinute: 2 } });

    expect(await statuses(2, () => toolsList(app, from('2001:db8:0:1::1')))).toEqual([200, 200]);
    expect((await toolsList(app, from('2001:db8:0:2::1'))).status).toBe(429);
    expect((await toolsList(app, from('2001:db8:1:0::1'))).status).toBe(200);
  });
});

describe('rate limiting per verified merchant', () => {
  it('gives two verified merchants calling from one address separate budgets', async () => {
    const app = await server({ rateLimit: { perMinute: 2, merchantPerMinute: 2 } });

    expect(await statuses(2, () => toolsList(app, bearer(MERCHANT_A_KEY)))).toEqual([200, 200]);
    expect(await statuses(2, () => toolsList(app, bearer(MERCHANT_B_KEY)))).toEqual([200, 200]);
    expect((await toolsList(app, bearer(MERCHANT_A_KEY))).status).toBe(429);
  });

  it('shares one budget for one merchant calling from two addresses, with different credentials', async () => {
    const app = await server({ trustProxyHops: 1, rateLimit: { perMinute: 2, merchantPerMinute: 2 } });

    expect((await toolsList(app, { ...bearer(MERCHANT_A_KEY), ...from('192.0.2.10') })).status).toBe(200);
    expect((await toolsList(app, { ...bearer(MERCHANT_A_SECOND_KEY), ...from('192.0.2.11') })).status).toBe(200);
    expect((await toolsList(app, { ...bearer(MERCHANT_A_KEY), ...from('192.0.2.12') })).status).toBe(429);
  });

  it('replaces the per-address budget for a verified merchant, with its own limit', async () => {
    const app = await server({ rateLimit: { perMinute: 1, merchantPerMinute: 3 } });

    expect(await statuses(2, () => toolsList(app))).toEqual([200, 429]);
    expect(await statuses(4, () => toolsList(app, bearer(MERCHANT_A_KEY)))).toEqual([200, 200, 200, 429]);
  });

  it('budgets an unverifiable bearer by address: new tokens never mint new buckets, and a verified merchant there keeps its own', async () => {
    const app = await server({ rateLimit: { perMinute: 3, merchantPerMinute: 2 } });
    const unverified = [GARBAGE_TOKEN, 'another-made-up-token', FOREIGN_KEY_CLAIMING_A, UNSIGNED_CLAIMING_A];

    expect(await statuses(4, (i) => toolsList(app, bearer(unverified[i])))).toEqual([200, 200, 200, 429]);
    expect((await toolsList(app)).status).toBe(429);
    // A token that only claims merchant A spent the address budget, not A's.
    expect(await statuses(3, () => toolsList(app, bearer(MERCHANT_A_KEY)))).toEqual([200, 200, 429]);
  });

  it('gives two verified merchants from one address separate execution budgets', async () => {
    const app = await server({ rateLimit: { executionPerMinute: 1 } });

    expect((await readPayout(app, MERCHANT_A_KEY)).status).toBe(200);
    expect((await readPayout(app, MERCHANT_B_KEY)).status).toBe(200);
    expect((await readPayout(app, MERCHANT_A_KEY)).status).toBe(429);
  });

  it('shares one execution budget for one merchant across addresses and credentials', async () => {
    const app = await server({ trustProxyHops: 1, rateLimit: { executionPerMinute: 1 } });

    expect((await readPayout(app, MERCHANT_A_KEY, from('192.0.2.10'))).status).toBe(200);
    expect((await readPayout(app, MERCHANT_A_SECOND_KEY, from('192.0.2.11'))).status).toBe(429);
  });

  it('budgets execution calls with unverifiable bearers by address', async () => {
    const app = await server({ rateLimit: { executionPerMinute: 2 } });

    expect(await statuses(3, (i) => readPayout(app, [GARBAGE_TOKEN, 'another-made-up-token', FOREIGN_KEY_CLAIMING_A][i]))).toEqual([200, 200, 429]);
    expect((await readPayout(app, MERCHANT_A_KEY)).status).toBe(200);
  });

  it('puts no merchant id or credential in any log or metric', async () => {
    const app = await server({ rateLimit: { merchantPerMinute: 1, executionPerMinute: 1 } });
    await statuses(3, () => readPayout(app, MERCHANT_A_KEY));
    await statuses(2, () => toolsList(app, bearer(MERCHANT_B_KEY)));

    await metricReader.forceFlush();
    const telemetry = JSON.stringify({
      metrics: metricExporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics.filter((m) => m.descriptor.name === 'mcp.http.rejected'))),
      logs: logRecords.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
    });
    for (const secret of [MERCHANT_A, MERCHANT_B, MERCHANT_A_KEY.split('.')[2], MERCHANT_B_KEY.split('.')[2]])
      expect(telemetry).not.toContain(secret);
  });
});

describe('client address behind proxies', () => {
  it('ignores entries a client prepends to X-Forwarded-For, with three trusted hops', async () => {
    const app = await server({ trustProxyHops: 3, rateLimit: { perMinute: 2 } });

    expect(await statuses(3, (i) => toolsList(app, viaRender('192.0.2.10', `203.0.113.${i + 1}`)))).toEqual([200, 200, 429]);
  });

  it('keys each real client separately, with three trusted hops', async () => {
    const app = await server({ trustProxyHops: 3, rateLimit: { perMinute: 1 } });

    expect((await toolsList(app, viaRender('192.0.2.10'))).status).toBe(200);
    expect((await toolsList(app, viaRender('192.0.2.11'))).status).toBe(200);
    expect((await toolsList(app, viaRender('192.0.2.10'))).status).toBe(429);
  });

  it('ignores X-Forwarded-For entirely when no proxy is trusted (the default)', async () => {
    const app = await server({ rateLimit: { perMinute: 2 }, env: { MIXPANEL_TOKEN, TRUST_PROXY_HOPS: undefined, RENDER: undefined } });

    expect(await statuses(3, (i) => toolsList(app, from(`203.0.113.${i + 1}`)))).toEqual([200, 200, 429]);
  });

  it('reads TRUST_PROXY_HOPS from env', async () => {
    const app = await server({ rateLimit: { perMinute: 1 }, env: { MIXPANEL_TOKEN, TRUST_PROXY_HOPS: '1' } });

    expect((await toolsList(app, from('192.0.2.10'))).status).toBe(200);
    expect((await toolsList(app, from('192.0.2.11'))).status).toBe(200);
  });

  for (const value of ['true', '-1', 'abc', '9', '1.5']) {
    it(`refuses to start with TRUST_PROXY_HOPS="${value}"`, async () => {
      await expect(server({ env: { TRUST_PROXY_HOPS: value } })).rejects.toThrow(/TRUST_PROXY_HOPS/);
    });
  }

  it('refuses to start on Render without TRUST_PROXY_HOPS, and starts with it', async () => {
    await expect(server({ env: { RENDER: 'true', TRUST_PROXY_HOPS: undefined } })).rejects.toThrow(/TRUST_PROXY_HOPS must be set on Render/);
    const app = await server({ env: { MIXPANEL_TOKEN, RENDER: 'true', TRUST_PROXY_HOPS: '3' } });
    expect((await toolsList(app)).status).toBe(200);
  });

  it('refuses to start with a malformed rate limit or shared-egress range', async () => {
    await expect(server({ rateLimit: {}, env: { RATE_LIMIT_PER_MINUTE: '0' } })).rejects.toThrow(/RATE_LIMIT_PER_MINUTE/);
    await expect(server({ rateLimit: {}, env: { RATE_LIMIT_EXECUTION_PER_MINUTE: 'lots' } })).rejects.toThrow(/RATE_LIMIT_EXECUTION_PER_MINUTE/);
    await expect(server({ rateLimit: {}, env: { RATE_LIMIT_SHARED_EGRESS_CIDRS: '160.79.104.0/33' } })).rejects.toThrow(/CIDR/);
  });
});

describe('client IP diagnostic', () => {
  function diagnostics() {
    return logRecords.getFinishedLogRecords().filter((record) => record.body === 'client ip diagnostic');
  }

  it('logs once, with the hop count it measured and no address, header value or credential', async () => {
    const app = await server({ trustProxyHops: 3, clientIpDiagnostic: true });
    await toolsList(app, { ...viaRender('192.0.2.10', '203.0.113.7'), Authorization: `Bearer ${SANDBOX_KEY}` });
    await toolsList(app, viaRender('192.0.2.11'));

    const records = diagnostics();
    expect(records).toHaveLength(1);
    expect(records[0].attributes).toMatchObject({
      trustProxyHops: 3,
      xffEntries: 4,
      hasTrueClientIp: true,
      trueClientIpIndexFromRight: 2,
      suggestedTrustProxyHops: 3,
      reqIpEqualsTrueClientIp: true,
      reqIpIsPrivate: false,
    });
    const serialized = JSON.stringify(records[0].attributes);
    for (const secret of ['192.0.2.10', '203.0.113.7', '162.158.0.1', '10.0.0.1', SANDBOX_KEY.split('.')[2]])
      expect(serialized).not.toContain(secret);
  });

  it('shows a wrong hop count: with one trusted hop, req.ip is the private proxy, not the client', async () => {
    const app = await server({ trustProxyHops: 1, clientIpDiagnostic: true });
    await toolsList(app, viaRender('192.0.2.10'));

    expect(diagnostics()[0].attributes).toMatchObject({
      trustProxyHops: 1,
      suggestedTrustProxyHops: 3,
      reqIpEqualsTrueClientIp: false,
      reqIpIsPrivate: true,
    });
  });

  it('logs nothing when off', async () => {
    const app = await server({ trustProxyHops: 3, env: { MIXPANEL_TOKEN, CLIENT_IP_DIAGNOSTIC: undefined } });
    await toolsList(app, viaRender('192.0.2.10'));

    expect(diagnostics()).toHaveLength(0);
  });
});

describe('health check', () => {
  it('answers 200 without the docs corpus, the upstream API or analytics', async () => {
    const silent = await startBrokenUpstream('silent');
    try {
      const app = await server({ apiHost: silent.origin, docsCorpusPath: undefined });
      const mixpanel = captureMixpanel();
      const startedAt = Date.now();
      const response = await fetch(app.url.replace('/mcp', '/healthz'));
      const head = await fetch(app.url.replace('/mcp', '/healthz'), { method: 'HEAD' });
      await flushApps();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ status: 'ok' });
      expect(head.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(silent.stats.connections).toBe(0);
      expect(mixpanel.events).toHaveLength(0);
    } finally {
      await silent.close();
    }
  });
});
