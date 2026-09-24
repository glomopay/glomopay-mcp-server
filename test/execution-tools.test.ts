import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { API_BASE, callTool, isRefused, jwt, resultText, startTestServer, type ITestServer } from './helpers';

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer();
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await server.close();
});

const SANDBOX = () => jwt('sandbox');

describe('endpoint auth', () => {
  it('rejects a request with no bearer', async () => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
  });
});

describe('path parameters', () => {
  it('interpolates a valid id to the expected URL', async () => {
    const scope = nock(API_BASE).get('/api/v1/payouts/pay_1').reply(200, { id: 'pay_1', status: 'processed' });
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: { id: 'pay_1' } }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(resultText(response)).toContain('processed');
    expect(scope.isDone()).toBe(true);
  });

  it('routes declared query params to the query string', async () => {
    const scope = nock(API_BASE).get('/api/v1/customer').query({ page: '2' }).reply(200, { data: [] });
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getCustomers', params: { page: 2 } }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  for (const badValue of ['.', '..', 'a/b', '']) {
    it(`refuses id "${badValue}" without calling the API`, async () => {
      const scope = nock(API_BASE).get(/.*/).reply(200, {});
      const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: { id: badValue } }, SANDBOX());
      expect(isRefused(response)).toBe(true);
      expect(scope.isDone()).toBe(false);
    });
  }

  it('refuses a missing path param', async () => {
    const scope = nock(API_BASE).get(/.*/).reply(200, {});
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });

  it('refuses a non-string path param', async () => {
    const scope = nock(API_BASE).get(/.*/).reply(200, {});
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: { id: 123 } }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });
});

describe('allowlist and read/write split', () => {
  it('refuses an operationId that is not on the allowlist', async () => {
    const response = await callTool(server.url, 'glomopay_api_write', { operationId: 'onboardMerchant', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
  });

  it('refuses a write operationId through the read tool', async () => {
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'createCustomer', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
  });

  it('refuses a read operationId through the write tool', async () => {
    const response = await callTool(server.url, 'glomopay_api_write', { operationId: 'getCustomers', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
  });
});

describe('sandbox-only write guard', () => {
  it('allows a write with a sandbox credential', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, { id: 'cust_1' });
    const response = await callTool(server.url, 'glomopay_api_write', { operationId: 'createCustomer', params: { name: 'A' } }, jwt('sandbox'));
    expect(isRefused(response)).toBe(false);
    expect(resultText(response)).toContain('cust_1');
    expect(scope.isDone()).toBe(true);
  });

  for (const [label, bearer] of [
    ['production', jwt('production')],
    ['missing env claim', jwt()],
    ['non-JWT', 'not-a-jwt'],
  ] as const) {
    it(`refuses a write with a ${label} credential without calling the API`, async () => {
      const scope = nock(API_BASE).post('/api/v1/customer').reply(201, { id: 'cust_1' });
      const response = await callTool(server.url, 'glomopay_api_write', { operationId: 'createCustomer', params: { name: 'A' } }, bearer);
      expect(isRefused(response)).toBe(true);
      expect(resultText(response)).toContain('sandbox-only');
      expect(scope.isDone()).toBe(false);
    });
  }
});

describe('downstream errors', () => {
  it('returns the API status code and error body', async () => {
    nock(API_BASE)
      .get('/api/v1/customer')
      .reply(422, { error: { field: 'required' } });
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getCustomers', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    const text = resultText(response);
    expect(text).toContain('422');
    expect(text).toContain('required');
  });
});

describe('method, payload and credential mapping', () => {
  it('sends a POST body built from params', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer', { name: 'A', email: 'a@b.com' }).reply(201, { id: 'cust_1' });
    const response = await callTool(
      server.url,
      'glomopay_api_write',
      { operationId: 'createCustomer', params: { name: 'A', email: 'a@b.com' } },
      jwt('sandbox'),
    );
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('maps a PATCH to the right method, path and body', async () => {
    const scope = nock(API_BASE).patch('/api/v1/payouts/pay_1/cancel', { reason: 'duplicate' }).reply(200, { id: 'pay_1', status: 'cancelled' });
    const response = await callTool(
      server.url,
      'glomopay_api_write',
      { operationId: 'cancelPayout', params: { id: 'pay_1', reason: 'duplicate' } },
      jwt('sandbox'),
    );
    expect(isRefused(response)).toBe(false);
    expect(resultText(response)).toContain('cancelled');
    expect(scope.isDone()).toBe(true);
  });

  it('maps a DELETE to the right method and path', async () => {
    const scope = nock(API_BASE).delete('/api/v1/virtual-accounts').reply(204);
    const response = await callTool(server.url, 'glomopay_api_write', { operationId: 'closeVirtualAccount', params: {} }, jwt('sandbox'));
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('forwards the caller credential as a Bearer token downstream', async () => {
    const token = jwt('sandbox');
    const scope = nock(API_BASE, { reqheaders: { authorization: `Bearer ${token}` } })
      .get('/api/v1/payouts/pay_9')
      .reply(200, { id: 'pay_9' });
    const response = await callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: { id: 'pay_9' } }, token);
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });
});

describe('per-request isolation', () => {
  it('routes concurrent requests with different credentials to their own responses', async () => {
    nock(API_BASE).get('/api/v1/payouts/pay_1').reply(200, { id: 'pay_1' });
    nock(API_BASE).get('/api/v1/payouts/pay_2').reply(200, { id: 'pay_2' });

    const [first, second] = await Promise.all([
      callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: { id: 'pay_1' } }, jwt('sandbox')),
      callTool(server.url, 'glomopay_api_read', { operationId: 'getPayoutById', params: { id: 'pay_2' } }, jwt('sandbox')),
    ]);

    expect(resultText(first)).toContain('pay_1');
    expect(resultText(first)).not.toContain('pay_2');
    expect(resultText(second)).toContain('pay_2');
    expect(resultText(second)).not.toContain('pay_1');
  });
});
