import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';

import { buildCorpus, type ICorpusPage } from '@/core/docs/docs.module';
import { startTelemetry } from '@/core/telemetry/telemetry.module';
import {
  API_BASE,
  callTool,
  captureMixpanel,
  initialize,
  isRefused,
  jwt,
  pause,
  resultText,
  SANDBOX_TOKEN,
  signApiKey,
  startBrokenUpstream,
  type IFakeUpstream,
  startTestServer,
  withCassette,
  type IMixpanelEvent,
  type ITestServer,
} from './helpers';

const MIXPANEL_TOKEN = 'mixpanel-test-project-token';
const PACKAGE_VERSION = (JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { version: string }).version;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MERCHANT = 'merch_4f9a8b7c6d5e';
const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

function apiKey(env: string, overrides: Record<string, unknown> = {}, privateKey = signingKeys.privateKey): string {
  return signApiKey(
    { sub: MERCHANT, env, jti: 'jti-must-not-leak', aud: 'aud-must-not-leak', iat: 1700000000, exp: FAR_FUTURE, ...overrides },
    privateKey,
  );
}

const SANDBOX_KEY = apiKey('sandbox');
const PRODUCTION_KEY = apiKey('production');

const CUSTOMER_BODY = {
  name: 'Body Name Must Not Leak',
  customer_type: 'individual',
  email: 'body-must-not-leak@example.com',
  address: '1 Body Street',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'IND',
};

let server: ITestServer;
let verifyingServer: ITestServer;
let silentServer: ITestServer;
let statusServer: ITestServer;
let statusUpstream: IFakeUpstream;
let corpusPath: string;

const RESPONSE_SENTINEL = { id: 'cust_response_must_not_leak', email: 'response-must-not-leak@example.com', error: 'response-error-must-not-leak' };

beforeAll(async () => {
  let corpus: ICorpusPage[] = [];
  await withCassette('docs-corpus.json', async () => {
    corpus = await buildCorpus();
  });
  corpusPath = path.join(os.tmpdir(), `analytics-corpus-${process.pid}.json`);
  writeFileSync(corpusPath, JSON.stringify(corpus));

  const publicPem = signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  server = await startTestServer({ docsCorpusPath: corpusPath, env: { MIXPANEL_TOKEN, GLOMO_JWT_PUBLIC_KEY: undefined } });
  verifyingServer = await startTestServer({ docsCorpusPath: corpusPath, env: { MIXPANEL_TOKEN, GLOMO_JWT_PUBLIC_KEY: publicPem } });
  silentServer = await startTestServer({ docsCorpusPath: corpusPath, env: { MIXPANEL_TOKEN: undefined } });
  statusUpstream = await startBrokenUpstream('status', { body: RESPONSE_SENTINEL });
  statusServer = await startTestServer({ apiHost: statusUpstream.origin, env: { MIXPANEL_TOKEN } });
});

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await Promise.all([server.close(), verifyingServer.close(), silentServer.close(), statusServer.close()]);
  await statusUpstream.close();
  rmSync(corpusPath, { force: true });
});

async function eventsFor(
  run: () => Promise<unknown>,
  expected: number,
): Promise<{ submitted: IMixpanelEvent; failed?: IMixpanelEvent; all: IMixpanelEvent[] }> {
  const mixpanel = captureMixpanel();
  await run();
  const all = await mixpanel.waitFor(expected);
  expect(all).toHaveLength(expected);
  return {
    submitted: all.find((event) => event.event === 'mcp_tool_submitted')!,
    failed: all.find((event) => event.event === 'mcp_tool_failed'),
    all,
  };
}

const onSuccess = (run: () => Promise<unknown>) => eventsFor(run, 1);
const onFailure = (run: () => Promise<unknown>) => eventsFor(run, 2);

describe('mcp_session_submitted', () => {
  it('is sent on initialize with the standard properties and the client', async () => {
    const mixpanel = captureMixpanel();
    const response = await initialize(server.url, { name: 'claude-code', version: '2.0.14' }, SANDBOX_KEY);
    expect(response.error).toBeUndefined();

    const [event] = await mixpanel.waitFor(1);
    expect(event.event).toBe('mcp_session_submitted');
    expect(event.properties).toMatchObject({
      distinct_id: MERCHANT,
      merchant_id: MERCHANT,
      product: 'mcp_server',
      platform: 'backend',
      environment: 'sandbox',
      mode: 'test',
      sdk_version: PACKAGE_VERSION,
      client_name: 'claude_code',
      client_version: '2.0.14',
      token: MIXPANEL_TOKEN,
    });
    expect(event.properties.mcp_request_id).toMatch(UUID);
  });

  it('turns off IP geolocation on every request', async () => {
    const mixpanel = captureMixpanel();
    await initialize(server.url, { name: 'cursor-vscode', version: '1.7.0' }, SANDBOX_KEY);
    await mixpanel.waitFor(1);
    expect(mixpanel.requests[0].query.get('ip')).toBe('0');
  });

  for (const [raw, expected] of [
    ['claude-code', 'claude_code'],
    ['Claude Code', 'claude_code'],
    ['cursor-vscode', 'cursor'],
    ['Visual Studio Code', 'vscode'],
    ['Visual Studio Code - Insiders', 'vscode'],
    ['windsurf-client', 'windsurf'],
    ['codex-mcp-client', 'codex'],
    ['my-own-agent', 'other'],
  ] as const) {
    it(`normalises clientInfo.name "${raw}" to ${expected}`, async () => {
      const mixpanel = captureMixpanel();
      await initialize(server.url, { name: raw, version: '1.0.0' }, SANDBOX_KEY);
      const [event] = await mixpanel.waitFor(1);
      expect(event.properties.client_name).toBe(expected);
    });
  }

  it('drops a client version that is not a version string', async () => {
    const mixpanel = captureMixpanel();
    await initialize(server.url, { name: 'claude-code', version: 'free text from jane@example.com' }, SANDBOX_KEY);
    const [event] = await mixpanel.waitFor(1);
    expect(event.properties.client_name).toBe('claude_code');
    expect(event.properties).not.toHaveProperty('client_version');
  });
});

describe('client on tools/call', () => {
  it('comes from the User-Agent, since a stateless request has no clientInfo', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY, { 'User-Agent': 'claude-code/2.0.14 (external, cli)' }),
    );
    expect(submitted.properties).toMatchObject({ client_name: 'claude_code', client_version: '2.0.14' });
  });

  it('is "other" for an unknown User-Agent, with no version', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY, { 'User-Agent': 'some-agent/9.9.9' }),
    );
    expect(submitted.properties.client_name).toBe('other');
    expect(submitted.properties).not.toHaveProperty('client_version');
  });
});

describe('mcp_tool_submitted per tool', () => {
  it('glomo_api_search: search_query and result_count, no operation_id or http_status', async () => {
    let text = '';
    const { submitted } = await onSuccess(async () => {
      text = resultText(await callTool(server.url, 'glomo_api_search', { query: 'create payout' }, SANDBOX_KEY));
    });
    const { results } = JSON.parse(text) as { results: unknown[] };
    expect(submitted.properties).toMatchObject({
      tool_name: 'glomo_api_search',
      status: 'success',
      search_query: 'create payout',
      result_count: results.length,
      product: 'mcp_server',
      platform: 'backend',
      environment: 'sandbox',
      mode: 'test',
      merchant_id: MERCHANT,
      distinct_id: MERCHANT,
      sdk_version: PACKAGE_VERSION,
    });
    expect(submitted.properties.mcp_request_id).toMatch(UUID);
    expect(typeof submitted.properties.duration_ms).toBe('number');
    expect(submitted.properties).not.toHaveProperty('operation_id');
    expect(submitted.properties).not.toHaveProperty('http_status');
    expect(submitted.properties).not.toHaveProperty('error_code');
  });

  it('glomo_docs_search: search_query and result_count', async () => {
    let text = '';
    const { submitted } = await onSuccess(async () => {
      text = resultText(await callTool(server.url, 'glomo_docs_search', { query: 'verify webhook signature' }, SANDBOX_KEY));
    });
    const { results } = JSON.parse(text) as { results: unknown[] };
    expect(submitted.properties).toMatchObject({
      tool_name: 'glomo_docs_search',
      search_query: 'verify webhook signature',
      result_count: results.length,
    });
  });

  it('glomo_implementation_planner: the goal as search_query', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_implementation_planner', { goal: 'accept card payments from US customers' }, SANDBOX_KEY),
    );
    expect(submitted.properties).toMatchObject({
      tool_name: 'glomo_implementation_planner',
      search_query: 'accept card payments from US customers',
    });
    expect(submitted.properties).not.toHaveProperty('result_count');
  });

  it('glomo_api_details: tool_name only, no operation_id for a list of ids', async () => {
    const { submitted } = await onSuccess(() => callTool(server.url, 'glomo_api_details', { operationIds: ['getPayoutById'] }, SANDBOX_KEY));
    expect(submitted.properties.tool_name).toBe('glomo_api_details');
    expect(submitted.properties).not.toHaveProperty('operation_id');
    expect(submitted.properties).not.toHaveProperty('search_query');
  });

  it('glomo_sample_request: operation_id, no http_status', async () => {
    const { submitted } = await onSuccess(() => callTool(server.url, 'glomo_sample_request', { operationId: 'getPayoutById' }, SANDBOX_KEY));
    expect(submitted.properties).toMatchObject({ tool_name: 'glomo_sample_request', operation_id: 'getPayoutById', status: 'success' });
    expect(submitted.properties).not.toHaveProperty('http_status');
  });

  it('glomo_api_read: operation_id and http_status', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(statusServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_1' } }, SANDBOX_KEY),
    );
    expect(statusUpstream.requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/payouts/payout_1' });
    expect(submitted.properties).toMatchObject({ tool_name: 'glomo_api_read', operation_id: 'getPayoutById', http_status: 200, status: 'success' });
  });

  it('glomo_api_write: operation_id and http_status', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(statusServer.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, SANDBOX_KEY),
    );
    expect(statusUpstream.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/customer' });
    expect(JSON.parse(statusUpstream.requests.at(-1)!.body)).toEqual(CUSTOMER_BODY);
    expect(submitted.properties).toMatchObject({ tool_name: 'glomo_api_write', operation_id: 'createCustomer', http_status: 201, status: 'success' });
  });
});

describe('status and error_code', () => {
  it('sends only mcp_tool_submitted on success', async () => {
    const { all } = await onSuccess(() => callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY));
    await pause(30);
    expect(all.map((event) => event.event)).toEqual(['mcp_tool_submitted']);
  });

  async function expectFailure(run: () => Promise<unknown>, errorCode: string) {
    const { submitted, failed } = await onFailure(run);
    expect(submitted.properties.status).toBe('failed');
    expect(submitted.properties).not.toHaveProperty('error_code');
    expect(failed).toBeDefined();
    expect(failed!.properties).toMatchObject({ status: 'failed', error_code: errorCode, tool_name: submitted.properties.tool_name });
    expect(failed!.properties.mcp_request_id).toBe(submitted.properties.mcp_request_id);
    return { submitted, failed: failed! };
  }

  it('validation_error when the arguments fail the input schema', async () => {
    const { failed } = await expectFailure(() => callTool(server.url, 'glomo_api_search', { query: '' }, SANDBOX_KEY), 'validation_error');
    expect(failed.properties).not.toHaveProperty('search_query');
  });

  it('validation_error for an unsafe path parameter, without calling the API', async () => {
    const scope = nock(API_BASE).get(/.*/).reply(200, {});
    const { failed } = await expectFailure(
      () => callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: '..' } }, SANDBOX_KEY),
      'validation_error',
    );
    expect(scope.isDone()).toBe(false);
    expect(failed.properties.operation_id).toBe('getPayoutById');
    expect(failed.properties).not.toHaveProperty('http_status');
  });

  it('unknown_operation for an operationId the spec does not have, and does not send it', async () => {
    const { failed } = await expectFailure(
      () => callTool(server.url, 'glomo_sample_request', { operationId: 'jane.doe@example.com' }, SANDBOX_KEY),
      'unknown_operation',
    );
    expect(failed.properties).not.toHaveProperty('operation_id');
    expect(JSON.stringify(failed)).not.toContain('jane.doe');
  });

  it('sandbox_only for a write with a production key, without calling the API', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
    await expectFailure(
      () => callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, PRODUCTION_KEY),
      'sandbox_only',
    );
    expect(scope.isDone()).toBe(false);
  });

  it('upstream_4xx with the real http_status for a recorded 404', async () => {
    await withCassette('get-payout-by-id-404.json', async () => {
      nock.enableNetConnect('127.0.0.1');
      const { failed } = await expectFailure(
        () =>
          callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_000000000000000000000000' } }, SANDBOX_TOKEN),
        'upstream_4xx',
      );
      expect(failed.properties).toMatchObject({ http_status: 404, operation_id: 'getPayoutById' });
    });
  });

  for (const [status, errorCode] of [
    [401, 'auth_rejected'],
    [403, 'auth_rejected'],
    [422, 'upstream_4xx'],
    [500, 'upstream_5xx'],
    [503, 'upstream_5xx'],
  ] as const) {
    it(`${errorCode} when the API answers ${status}`, async () => {
      const id = `payout_status_${status}`;
      const { failed } = await expectFailure(
        () => callTool(statusServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id } }, SANDBOX_KEY),
        errorCode,
      );
      expect(statusUpstream.requests.some((request) => request.path === `/api/v1/payouts/${id}`)).toBe(true);
      expect(failed.properties.http_status).toBe(status);
    });
  }

  it('timeout when the API call does not answer in time', async () => {
    const upstream = await startBrokenUpstream('silent');
    const slowServer = await startTestServer({ apiHost: upstream.origin, downstreamTimeoutMs: 100, env: { MIXPANEL_TOKEN } });
    try {
      const { failed } = await expectFailure(
        () => callTool(slowServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_3' } }, SANDBOX_KEY),
        'timeout',
      );
      expect(failed.properties).not.toHaveProperty('http_status');
    } finally {
      await slowServer.close();
      await upstream.close();
    }
  });

  it('internal when the connection drops without a response', async () => {
    const upstream = await startBrokenUpstream('reset');
    const brokenServer = await startTestServer({ apiHost: upstream.origin, env: { MIXPANEL_TOKEN } });
    try {
      const { failed } = await expectFailure(
        () => callTool(brokenServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_4' } }, SANDBOX_KEY),
        'internal',
      );
      expect(failed.properties).not.toHaveProperty('http_status');
    } finally {
      await brokenServer.close();
      await upstream.close();
    }
  });

  for (const behaviour of ['silent', 'reset'] as const) {
    it(`tells the agent a write's outcome is unknown when the upstream ${behaviour === 'silent' ? 'times out' : 'drops the connection'}`, async () => {
      const upstream = await startBrokenUpstream(behaviour);
      const writeServer = await startTestServer({ apiHost: upstream.origin, downstreamTimeoutMs: 100 });
      try {
        const response = await callTool(writeServer.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, SANDBOX_KEY);
        expect(isRefused(response)).toBe(true);
        const text = resultText(response);
        expect(text).toContain('outcome of "createCustomer" is unknown');
        expect(text).toContain('look the resource up');
        expect(text).toContain('do not retry with a new request_id');
      } finally {
        await writeServer.close();
        await upstream.close();
      }
    });
  }

  for (const status of [500, 502, 503, 504]) {
    it(`tells the agent a write's outcome is unknown when the API answers ${status}`, async () => {
      const response = await callTool(
        statusServer.url,
        'glomo_api_write',
        { operationId: 'cancelPayout', params: { id: `payout_status_${status}`, reason: 'duplicate' } },
        SANDBOX_KEY,
      );
      expect(isRefused(response)).toBe(true);
      const text = resultText(response);
      expect(text).toContain(`outcome of "cancelPayout" is unknown: the API answered ${status}`);
      expect(text).toContain('look the resource up');
      expect(text).toContain('do not retry with a new request_id');
    });
  }

  it('keeps the plain error for a write the API rejects with a 4xx', async () => {
    const response = await callTool(
      statusServer.url,
      'glomo_api_write',
      { operationId: 'cancelPayout', params: { id: 'payout_status_422', reason: 'duplicate' } },
      SANDBOX_KEY,
    );
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('"statusCode":422');
    expect(resultText(response)).not.toContain('unknown');
  });

  it('keeps the plain error for a read the API answers with 503', async () => {
    const response = await callTool(
      statusServer.url,
      'glomo_api_read',
      { operationId: 'getPayoutById', params: { id: 'payout_status_503' } },
      SANDBOX_KEY,
    );
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('"statusCode":503');
    expect(resultText(response)).not.toContain('unknown');
  });

  it('keeps the plain error for a read that times out', async () => {
    const upstream = await startBrokenUpstream('silent');
    const readServer = await startTestServer({ apiHost: upstream.origin, downstreamTimeoutMs: 100 });
    try {
      const response = await callTool(readServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_6' } }, SANDBOX_KEY);
      expect(isRefused(response)).toBe(true);
      expect(resultText(response)).not.toContain('unknown');
    } finally {
      await readServer.close();
      await upstream.close();
    }
  });

  it('sends nothing for a tool that is not registered', async () => {
    const mixpanel = captureMixpanel();
    const response = await callTool(server.url, 'not_a_tool', {}, SANDBOX_KEY);
    expect(isRefused(response)).toBe(true);
    await pause(50);
    expect(mixpanel.events).toHaveLength(0);
  });
});

describe('identity', () => {
  it('reads merchant_id, environment and mode from a sandbox key', async () => {
    const { submitted } = await onSuccess(() => callTool(server.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY));
    expect(submitted.properties).toMatchObject({ distinct_id: MERCHANT, merchant_id: MERCHANT, environment: 'sandbox', mode: 'test' });
  });

  it('reads merchant_id, environment and mode from a production key', async () => {
    const { submitted } = await onSuccess(() => callTool(server.url, 'glomo_api_search', { query: 'payout' }, PRODUCTION_KEY));
    expect(submitted.properties).toMatchObject({ distinct_id: MERCHANT, merchant_id: MERCHANT, environment: 'production', mode: 'live' });
  });

  it('decodes without verifying when no public key is configured', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_api_search', { query: 'payout' }, apiKey('sandbox', {}, otherKeys.privateKey)),
    );
    expect(submitted.properties.merchant_id).toBe(MERCHANT);
  });

  it('keeps the identity of a key whose signature verifies', async () => {
    const { submitted } = await onSuccess(() => callTool(verifyingServer.url, 'glomo_api_search', { query: 'payout' }, PRODUCTION_KEY));
    expect(submitted.properties).toMatchObject({ distinct_id: MERCHANT, merchant_id: MERCHANT, environment: 'production', mode: 'live' });
  });

  for (const [label, token] of [
    ['is signed by another key', apiKey('sandbox', {}, otherKeys.privateKey)],
    ['is unsigned', jwt('sandbox', { sub: MERCHANT })],
    ['claims a non-RS256 algorithm', signApiKey({ sub: MERCHANT, env: 'sandbox' }, signingKeys.privateKey, { alg: 'HS256' })],
    ['has expired', apiKey('sandbox', { exp: Math.floor(Date.now() / 1000) - 60 })],
  ] as const) {
    it(`treats a key that ${label} as anonymous when verification is on`, async () => {
      const { submitted } = await onSuccess(() => callTool(verifyingServer.url, 'glomo_api_search', { query: 'payout' }, token));
      expect(submitted.properties.distinct_id).toBe('');
      expect(submitted.properties).not.toHaveProperty('merchant_id');
      expect(submitted.properties).not.toHaveProperty('mode');
      expect(submitted.properties).not.toHaveProperty('environment');
    });
  }

  it('sends an anonymous event for a key that is not a JWT', async () => {
    const { submitted } = await onSuccess(() => callTool(server.url, 'glomo_api_search', { query: 'payout' }, 'not-a-jwt'));
    expect(submitted.properties.distinct_id).toBe('');
    expect(submitted.properties).not.toHaveProperty('merchant_id');
    expect(submitted.properties).not.toHaveProperty('mode');
    expect(submitted.properties).not.toHaveProperty('environment');
    expect(submitted.properties).toMatchObject({ product: 'mcp_server', platform: 'backend', tool_name: 'glomo_api_search' });
  });

  it('sends an anonymous session event for a key that is not a JWT', async () => {
    const mixpanel = captureMixpanel();
    await initialize(server.url, { name: 'claude-code', version: '2.0.14' }, 'not-a-jwt');
    const [event] = await mixpanel.waitFor(1);
    expect(event.properties.distinct_id).toBe('');
    expect(event.properties).not.toHaveProperty('merchant_id');
  });
});

describe('search_query redaction', () => {
  const search = (query: string) => onSuccess(() => callTool(server.url, 'glomo_api_search', { query }, SANDBOX_KEY));

  for (const [label, query, expected] of [
    ['an email', 'refund to jane.doe@example.com today', 'refund to [email] today'],
    ['an international phone number', 'call +91 98765 43210 back', 'call [phone] back'],
    ['a bare phone number', 'call 9876543210 back', 'call [phone] back'],
    ['a PAN', 'kyc for ABCPE1234F failed', 'kyc for [pan] failed'],
    ['a lower-case PAN', 'kyc for abcpe1234f failed', 'kyc for [pan] failed'],
    ['a spaced Aadhaar', 'aadhaar 1234 5678 9012 check', 'aadhaar [aadhaar] check'],
    ['an unspaced Aadhaar', 'aadhaar 123456789012 check', 'aadhaar [aadhaar] check'],
    ['a spaced card number', 'card 4111 1111 1111 1111 declined', 'card [card] declined'],
    ['a dashed card number', 'card 4111-1111-1111-1111 declined', 'card [card] declined'],
    ['a bare card number', 'card 4111111111111111 declined', 'card [card] declined'],
    ['a 13-digit card number', 'card 4222222222222 declined', 'card [card] declined'],
    ['a long digit run', 'account 123456789 balance', 'account [number] balance'],
    ['a JWT', 'why is eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtZXJjaF8xIn0.c2lnbmF0dXJl rejected', 'why is [jwt] rejected'],
    ['a live_ key', 'key live_6a1f3c2eX9kQ3zPw fails', 'key [key] fails'],
    ['a test_ key', 'key test_6a1f3c2e4f9a8B7c fails', 'key [key] fails'],
    ['a long hex string', 'secret 3f786850e387550fdab836ed7e6dc881de23001b here', 'secret [key] here'],
    ['a long base64 string', 'secret dGhpc2lzYXZlcnlsb25nc2VjcmV0dmFsdWUxMjM0NTY3OA== here', 'secret [key] here'],
    ['surrounding whitespace', '   create payout   ', 'create payout'],
    ['a PAN inside a GSTIN', 'GSTIN 27ABCPE1234F1Z5', 'GSTIN 27[pan]1Z5'],
    ['a PAN run into words', 'forABCPE1234Ffailed', 'for[pan]failed'],
    ['a company PAN', 'pan AAACR5055K on file', 'pan [pan] on file'],
    ['an Aadhaar with double spaces', 'aadhaar 1234  5678  9012', 'aadhaar [aadhaar]'],
    ['an Aadhaar with spaced dashes', 'aadhaar 1234 - 5678 - 9012', 'aadhaar [aadhaar]'],
    ['a slashed card number', 'card 4111/1111/1111/1111', 'card [card]'],
    ['an underscored card number', 'card 4111_1111_1111_1111', 'card [card]'],
    ['a double-spaced card number', 'card 4111  1111  1111  1111', 'card [card]'],
    ['a dotted card number', 'card 4111.1111.1111.1111 declined', 'card [card] declined'],
    ['a phone number with a no-break space', 'call 98765\u00a043210 back', 'call [phone] back'],
    ['full-width digits', 'account １２３４５６７８９ balance', 'account [number] balance'],
    ['a UPI ID', 'pay jane@okhdfc now', 'pay [upi] now'],
    ['a JWT with spaces around the dots', 'jwt eyJhbGciOiJSUzI1NiJ9 . eyJzdWIiOiJtZXJjaF8xIn0 . c2lnbmF0dXJl', 'jwt [jwt]'],
    ['a live_ key whose random part has no digits', 'key live_6a1f3c2eabcdEFGH', 'key [key]'],
    ['an upper-case LIVE_ key', 'key LIVE_6A1F3C2EX9KQ3ZPW', 'key [key]'],
    ['a live- key', 'key live-6a1f3c2ex9kq3zpw', 'key [key]'],
    ['a card number with en dashes', 'card 4111\u20131111\u20131111\u20131111 declined', 'card [card] declined'],
    ['a card number with em dashes', 'card 4111\u20141111\u20141111\u20141111 declined', 'card [card] declined'],
    ['a card number with hyphen characters', 'card 4111\u20101111\u20101111\u20101111 declined', 'card [card] declined'],
    ['a card number with minus signs', 'card 4111\u22121111\u22121111\u22121111 declined', 'card [card] declined'],
    ['an Aadhaar with en dashes', 'aadhaar 1234\u20135678\u20139012 check', 'aadhaar [aadhaar] check'],
    ['a phone number with an en dash', 'call 98765\u201343210 back', 'call [phone] back'],
    ['a card number split by zero-width spaces', 'card 4111\u200b1111\u200b1111\u200b1111 declined', 'card [card] declined'],
    ['a PAN split by a zero-width space', 'kyc ABC\u200bPK1234X failed', 'kyc [pan] failed'],
    ['a UPI handle with a digit', 'pay jane@ok2hdfc now', 'pay [upi] now'],
    ['a 24-character base64 secret', 'secret c2VjcmV0S2V5MTIzNDU2Nzg5 here', 'secret [key] here'],
    ['a digit run split by mixed separators', 'ref 12 34/56.78_9 end', 'ref [number] end'],
    ['an all-letter hex secret', 'token deadbeefcafebabedeadbeefcafebabe here', 'token [key] here'],
    ['a card number split by tabs and newlines', 'card 4111\t1111\n1111\t1111 declined', 'card [card] declined'],
    ['line breaks inside the text', 'create\n\n  payout', 'create payout'],
  ] as const) {
    it(`masks ${label}`, async () => {
      const { submitted } = await search(query);
      expect(submitted.properties.search_query).toBe(expected);
    });
  }

  for (const query of [
    'create a payout in USD',
    'list payouts for 2024',
    'test_mode webhook',
    'test_environments',
    'live_transactions',
    'list_payouts_by_customer_2024',
    'getTransactionsLinkedToSettlement',
    'P1006 purpose code',
    'payin2024q',
    'getPayouts',
    'order_2024abcd',
    'refund for payin2024q on getPayouts',
  ]) {
    it(`leaves ordinary text alone: "${query}"`, async () => {
      const { submitted } = await search(query);
      expect(submitted.properties.search_query).toBe(query);
    });
  }

  it('caps search_query at 200 characters', async () => {
    const { submitted } = await onSuccess(() => callTool(server.url, 'glomo_docs_search', { query: 'webhook '.repeat(50) }, SANDBOX_KEY));
    const sent = submitted.properties.search_query as string;
    expect(sent.length).toBeLessThanOrEqual(200);
    expect(sent.length).toBeGreaterThan(190);
    expect(sent.startsWith('webhook webhook')).toBe(true);
  });

  it('masks before capping, so a value on the boundary never leaks in part', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_docs_search', { query: `${'a'.repeat(190)} 4111 1111 1111 1111` }, SANDBOX_KEY),
    );
    expect(submitted.properties.search_query).not.toMatch(/\d/);
  });

  it('caps the planner goal at 200 characters too, after masking', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_implementation_planner', { goal: `${'plan '.repeat(60)} jane@okhdfc` }, SANDBOX_KEY),
    );
    expect(submitted.properties.tool_name).toBe('glomo_implementation_planner');
    expect((submitted.properties.search_query as string).length).toBeLessThanOrEqual(200);
    expect(submitted.properties.search_query).not.toContain('okhdfc');
  });

  it('redacts the planner goal too', async () => {
    const { submitted } = await onSuccess(() =>
      callTool(server.url, 'glomo_implementation_planner', { goal: 'pay out to jane.doe@example.com via 4111 1111 1111 1111' }, SANDBOX_KEY),
    );
    expect(submitted.properties.search_query).toBe('pay out to [email] via [card]');
  });
});

describe('what is never sent', () => {
  const ALLOWED_PROPERTIES = new Set([
    // Added by the Mixpanel library / ingestion.
    'token',
    'time',
    'distinct_id',
    // Standard properties.
    'product',
    'platform',
    'environment',
    'mode',
    'merchant_id',
    'sdk_version',
    // Per-event properties.
    'tool_name',
    'operation_id',
    'status',
    'error_code',
    'http_status',
    'duration_ms',
    'result_count',
    'search_query',
    'client_name',
    'client_version',
    'mcp_request_id',
  ]);

  it('carries no arguments, bodies, tokens or extra claims', async () => {
    const mixpanel = captureMixpanel();
    await callTool(statusServer.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, SANDBOX_KEY);
    await callTool(statusServer.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'payout_5_status_422' } }, SANDBOX_KEY);
    expect(statusUpstream.requests.some((request) => request.body.includes('Body Name Must Not Leak'))).toBe(true);
    await mixpanel.waitFor(3);

    const wire = JSON.stringify(mixpanel.events) + mixpanel.requests.map((request) => request.query.toString()).join('&');
    for (const secret of [
      SANDBOX_KEY,
      SANDBOX_KEY.split('.')[1],
      'jti-must-not-leak',
      'aud-must-not-leak',
      'Body Name Must Not Leak',
      'body-must-not-leak',
      '1 Body Street',
      'must-not-leak',
      'payout_5',
    ]) {
      expect(wire).not.toContain(secret);
    }
    for (const event of mixpanel.events) {
      for (const key of Object.keys(event.properties)) expect(ALLOWED_PROPERTIES).toContain(key);
    }
  });
});

describe('without MIXPANEL_TOKEN', () => {
  it('sends nothing', async () => {
    const mixpanel = captureMixpanel();
    await initialize(silentServer.url, { name: 'claude-code', version: '2.0.14' }, SANDBOX_KEY);
    const response = await callTool(silentServer.url, 'glomo_api_search', { query: 'payout' }, SANDBOX_KEY);
    expect(isRefused(response)).toBe(false);
    await pause(50);
    expect(mixpanel.scope.isDone()).toBe(false);
    expect(mixpanel.events).toHaveLength(0);
  });

  it('leaves OpenTelemetry off when no OTLP endpoint is configured', () => {
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(startTelemetry()).toBe(false);
  });
});

describe('a Mixpanel failure never fails the tool call', () => {
  it('returns the tool result when Mixpanel answers with an error status', async () => {
    const mixpanel = captureMixpanel({ status: 500, body: '0' });
    const response = await callTool(server.url, 'glomo_api_search', { query: 'create payout' }, SANDBOX_KEY);
    expect(isRefused(response)).toBe(false);
    expect(JSON.parse(resultText(response))).toHaveProperty('results');
    await mixpanel.waitFor(1);
    expect(mixpanel.events).toHaveLength(1);
  });

  for (const behaviour of ['reset', 'silent'] as const) {
    it(`returns the tool result promptly when the Mixpanel host ${behaviour === 'reset' ? 'drops connections' : 'never answers'}`, async () => {
      const sink = await startBrokenUpstream(behaviour);
      const app = await startTestServer({ env: { MIXPANEL_TOKEN, MIXPANEL_HOST: sink.origin }, analyticsTimeoutMs: 200 });
      try {
        const started = Date.now();
        const response = await callTool(app.url, 'glomo_api_search', { query: 'create payout' }, SANDBOX_KEY);
        expect(isRefused(response)).toBe(false);
        expect(Date.now() - started).toBeLessThan(500);
        const deadline = Date.now() + 2000;
        while (sink.stats.connections === 0 && Date.now() < deadline) await pause(5);
        expect(sink.stats.connections).toBeGreaterThan(0);
      } finally {
        await app.close();
        await sink.close();
      }
    });
  }
});
