import { logRecords, metricExporter, metricReader, spans } from './otel-setup';

import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { DataPoint, Histogram } from '@opentelemetry/sdk-metrics';

import { flushApps } from '@/core/app/app.module';
import { shutdownTelemetry } from '@/core/telemetry/telemetry.module';
import {
  API_BASE,
  callTool,
  captureMixpanel,
  isRefused,
  signApiKey,
  startBrokenUpstream,
  startTestServer,
  UPSTREAM_REQUEST_ID,
  type IFakeUpstream,
  type ITestServer,
} from './helpers';

const MERCHANT = 'merch_4f9a8b7c6d5e';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SANDBOX_KEY = signApiKey({ sub: MERCHANT, env: 'sandbox', jti: 'jti-must-not-leak' }, keys.privateKey);
const PRODUCTION_KEY = signApiKey({ sub: MERCHANT, env: 'production' }, keys.privateKey);

const CUSTOMER_BODY = {
  name: 'Body Name Must Not Leak',
  customer_type: 'individual',
  email: 'body-must-not-leak@example.com',
  address: '1 Body Street',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'IND',
};

const RESPONSE_SENTINEL = { id: 'cust_response_must_not_leak', email: 'response-must-not-leak@example.com' };

let server: ITestServer;
let statusServer: ITestServer;
let statusUpstream: IFakeUpstream;

beforeAll(async () => {
  server = await startTestServer({ env: { MIXPANEL_TOKEN: 'mixpanel-test-project-token' } });
  statusUpstream = await startBrokenUpstream('status', { body: RESPONSE_SENTINEL });
  statusServer = await startTestServer({ apiHost: statusUpstream.origin, env: { MIXPANEL_TOKEN: 'mixpanel-test-project-token' } });
});

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  spans.reset();
  logRecords.reset();
});

afterEach(async () => {
  // Deliver this test's analytics before its interceptors go, so none reach the next test.
  await flushApps();
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await Promise.all([server.close(), statusServer.close()]);
  await statusUpstream.close();
  await shutdownTelemetry();
});

function toolSpans(): ReadableSpan[] {
  return spans.getFinishedSpans().filter((span) => span.name.startsWith('tools/call '));
}

async function metricPoints(name: string): Promise<DataPoint<number | Histogram>[]> {
  await metricReader.forceFlush();
  const latest = metricExporter.getMetrics().at(-1);
  const metric = latest?.scopeMetrics.flatMap((scope) => scope.metrics).find((entry) => entry.descriptor.name === name);
  return (metric?.dataPoints ?? []) as DataPoint<number | Histogram>[];
}

async function counterValue(name: string, attributes: Record<string, string> = {}): Promise<number> {
  const points = await metricPoints(name);
  const match = points.find((point) => Object.entries(attributes).every(([key, value]) => point.attributes[key] === value));
  return (match?.value as number | undefined) ?? 0;
}

async function histogramCount(name: string, attributes: Record<string, string>): Promise<number> {
  const points = await metricPoints(name);
  const match = points.find((point) => Object.entries(attributes).every(([key, value]) => point.attributes[key] === value));
  return (match?.value as Histogram | undefined)?.count ?? 0;
}

describe('traces', () => {
  it('records one span per tools/call with its attributes', async () => {
    const scope = nock(API_BASE).get('/api/v1/payouts/payout_1').reply(200, {});
    await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_1' } }, SANDBOX_KEY);
    expect(scope.isDone()).toBe(true);

    const [span] = toolSpans();
    expect(toolSpans()).toHaveLength(1);
    expect(span.name).toBe('tools/call glomo_api_read');
    expect(span.attributes).toMatchObject({ toolName: 'glomo_api_read', operationId: 'getPayoutById', status: 'success' });
    expect(span.attributes.mcpRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(span.attributes).not.toHaveProperty('errorCode');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks a failed call with status, errorCode and an error span status', async () => {
    await callTool(statusServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_status_503' } }, SANDBOX_KEY);

    const [span] = toolSpans();
    expect(span.attributes).toMatchObject({ status: 'failed', errorCode: 'upstream_5xx', operationId: 'getPayoutById' });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records a span for a call refused by input validation', async () => {
    await callTool(server.url, 'glomo_api_search', { query: '' }, SANDBOX_KEY);
    const [span] = toolSpans();
    expect(span.attributes).toMatchObject({ toolName: 'glomo_api_search', status: 'failed', errorCode: 'validation_error' });
  });

  it('nests the downstream HTTP call under the tool span, without its query string', async () => {
    const scope = nock(API_BASE).get('/api/v1/customer').query({ page: '2' }).reply(200, {});
    await callTool(server.url, 'glomo_api_read', { operationId: 'getCustomers', params: { page: 2 } }, SANDBOX_KEY);
    expect(scope.isDone()).toBe(true);

    const [toolSpan] = toolSpans();
    const client = spans
      .getFinishedSpans()
      .find((span) => span.kind === SpanKind.CLIENT && span.parentSpanContext?.spanId === toolSpan.spanContext().spanId);
    expect(client).toBeDefined();
    expect(client!.spanContext().traceId).toBe(toolSpan.spanContext().traceId);
    expect(client!.attributes['url.full']).toBe(`${API_BASE}/api/v1/customer`);
    expect(String(client!.attributes['url.full'])).not.toContain('page');
  });

  it('records the downstream URL as the path template, never the concrete path', async () => {
    const id = 'jane.doe@example.com ABCDE1234F';
    await callTool(statusServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id } }, SANDBOX_KEY);
    expect(statusUpstream.requests.some((request) => request.path === `/api/v1/payouts/${encodeURIComponent(id)}`)).toBe(true);

    const client = spans.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client!.attributes['url.full']).toBe(`${statusUpstream.origin}/api/v1/payouts/{id}`);
    expect(client!.attributes['url.path']).toBe('/api/v1/payouts/{id}');
  });

  it('does not trace incoming requests, so no span carries the client address or User-Agent', async () => {
    await callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY, {
      'X-Forwarded-For': '203.0.113.77',
      'User-Agent': 'ua-sentinel/4.2',
    });
    expect(spans.getFinishedSpans().some((span) => span.kind === SpanKind.SERVER)).toBe(false);
    expect(toolSpans()).toHaveLength(1);
  });

  it('carries the same mcpRequestId as the Mixpanel event, so the two can be joined', async () => {
    const mixpanel = captureMixpanel();
    await callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY);
    const [event] = await mixpanel.waitFor(1);
    const [span] = toolSpans();
    expect(mixpanel.events).toHaveLength(1);
    expect(span.attributes.mcpRequestId).toBe(event.properties.mcp_request_id);
  });

  it('does not trace the analytics requests themselves', async () => {
    const mixpanel = captureMixpanel();
    await callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY);
    await mixpanel.waitFor(1);
    expect(spans.getFinishedSpans().some((span) => String(span.attributes['server.address']).includes('mixpanel'))).toBe(false);
  });
});

describe('metrics', () => {
  it('counts calls and records duration by toolName and status', async () => {
    const successBefore = await counterValue('mcp.tool.calls', { toolName: 'glomo_sample_request', status: 'success' });
    const failedBefore = await counterValue('mcp.tool.calls', { toolName: 'glomo_sample_request', status: 'failed' });
    const durationBefore = await histogramCount('mcp.tool.duration', { toolName: 'glomo_sample_request', status: 'success' });

    await callTool(server.url, 'glomo_sample_request', { operationId: 'getPayoutById' }, SANDBOX_KEY);
    await callTool(server.url, 'glomo_sample_request', { operationId: 'getPayoutById' }, SANDBOX_KEY);
    await callTool(server.url, 'glomo_sample_request', { operationId: 'notAnOperation' }, SANDBOX_KEY);

    expect(await counterValue('mcp.tool.calls', { toolName: 'glomo_sample_request', status: 'success' })).toBe(successBefore + 2);
    expect(await counterValue('mcp.tool.calls', { toolName: 'glomo_sample_request', status: 'failed' })).toBe(failedBefore + 1);
    expect(await histogramCount('mcp.tool.duration', { toolName: 'glomo_sample_request', status: 'success' })).toBe(durationBefore + 2);
  });

  it('counts analytics events Mixpanel did not accept in mcp.analytics.dropped', async () => {
    const before = await counterValue('mcp.analytics.dropped');
    const mixpanel = captureMixpanel({ status: 500, body: '0' });
    const response = await callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY);
    expect(isRefused(response)).toBe(false);
    await mixpanel.waitFor(1);

    const deadline = Date.now() + 2000;
    while ((await counterValue('mcp.analytics.dropped')) === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(await counterValue('mcp.analytics.dropped')).toBe(before + 1);
  });
});

describe('logs', () => {
  it('writes one audit record per glomo_api_write call, inside the tool span, without bodies', async () => {
    await callTool(statusServer.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, SANDBOX_KEY);
    expect(statusUpstream.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/customer' });
    expect(JSON.parse(statusUpstream.requests.at(-1)!.body)).toEqual(CUSTOMER_BODY);

    const audits = logRecords.getFinishedLogRecords().filter((record) => record.body === 'glomo_api_write call');
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit.attributes).toMatchObject({
      merchantId: MERCHANT,
      operationId: 'createCustomer',
      httpStatus: 201,
      downstreamRequestId: UPSTREAM_REQUEST_ID,
      status: 'success',
    });

    const [toolSpan] = toolSpans();
    expect(audit.spanContext?.traceId).toBe(toolSpan.spanContext().traceId);
    expect(audit.spanContext?.spanId).toBe(toolSpan.spanContext().spanId);
    expect(audit.attributes.mcpRequestId).toBe(toolSpan.attributes.mcpRequestId);

    const serialised = JSON.stringify({ body: audit.body, attributes: audit.attributes });
    for (const secret of ['must-not-leak', 'Body Name', '1 Body Street', SANDBOX_KEY]) expect(serialised).not.toContain(secret);
  });

  it('audits a refused write too, with its errorCode and no httpStatus', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
    await callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, PRODUCTION_KEY);
    expect(scope.isDone()).toBe(false);

    const [audit] = logRecords.getFinishedLogRecords().filter((record) => record.body === 'glomo_api_write call');
    expect(audit.attributes).toMatchObject({ merchantId: MERCHANT, operationId: 'createCustomer', status: 'failed', errorCode: 'sandbox_only' });
    expect(audit.attributes).not.toHaveProperty('httpStatus');
  });

  it('writes no audit record for a read', async () => {
    const scope = nock(API_BASE).get('/api/v1/payouts/payout_3').reply(200, {});
    await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_3' } }, SANDBOX_KEY);
    expect(scope.isDone()).toBe(true);
    expect(logRecords.getFinishedLogRecords().filter((record) => record.body === 'glomo_api_write call')).toHaveLength(0);
  });
});

describe('what telemetry never carries', () => {
  const SENTINELS = {
    pathParam: 'payout_pathsentinel9x',
    queryParam: 'querysentinel7q',
    bodyValue: 'bodysentinel3k',
    responseBody: 'response-must-not-leak',
    searchText: 'searchsentinel5m',
    goalText: 'goalsentinel2p',
    clientIp: '203.0.113.77',
    userAgent: 'ua-sentinel/4.2',
  };

  it('holds no tool arguments, bodies, token, concrete path values, client IP or User-Agent in any span, metric or log', async () => {
    const headers = { 'X-Forwarded-For': SENTINELS.clientIp, 'User-Agent': SENTINELS.userAgent };
    await callTool(statusServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: SENTINELS.pathParam } }, SANDBOX_KEY, headers);
    await callTool(statusServer.url, 'glomo_api_read', { operationId: 'getCustomers', params: { page: SENTINELS.queryParam } }, SANDBOX_KEY, headers);
    await callTool(
      statusServer.url,
      'glomo_api_write',
      { operationId: 'createCustomer', params: { ...CUSTOMER_BODY, name: SENTINELS.bodyValue } },
      SANDBOX_KEY,
      headers,
    );
    await callTool(
      statusServer.url,
      'glomo_api_read',
      { operationId: 'getPayoutById', params: { id: `${SENTINELS.pathParam}_status_503` } },
      SANDBOX_KEY,
      headers,
    );
    await callTool(statusServer.url, 'glomo_api_search', { query: SENTINELS.searchText }, SANDBOX_KEY, headers);
    await callTool(statusServer.url, 'glomo_implementation_planner', { goal: SENTINELS.goalText }, SANDBOX_KEY, headers);
    expect(statusUpstream.requests.some((request) => request.body.includes(SENTINELS.bodyValue))).toBe(true);

    await metricReader.forceFlush();
    const everything = JSON.stringify({
      spans: spans.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
        links: span.links,
        resource: span.resource.attributes,
      })),
      metrics: metricExporter
        .getMetrics()
        .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
        .map((metric) => ({ name: metric.descriptor.name, points: metric.dataPoints.map((point) => point.attributes) })),
      logs: logRecords.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
    });

    expect(spans.getFinishedSpans().length).toBeGreaterThan(6);
    for (const sentinel of [...Object.values(SENTINELS), SANDBOX_KEY, SANDBOX_KEY.split('.')[2], 'jti-must-not-leak', '1 Body Street']) {
      expect(everything).not.toContain(sentinel);
    }
  });
});
