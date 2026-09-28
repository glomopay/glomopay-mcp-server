import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';

import { API_BASE, callTool, isRefused, jwt, startTestServer, TEST_PUBLIC_KEY, type ITestServer, type ITestServerOptions } from './helpers';

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
});

afterEach(() => {
  nock.cleanAll();
});

const CUSTOMER_BODY = {
  name: 'MCP Test Customer',
  customer_type: 'individual',
  email: 'mcp-test@example.com',
  address: '1 Test Street',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'IND',
};

async function withServer(overrides: ITestServerOptions, run: (server: ITestServer) => Promise<void>) {
  const server = await startTestServer(overrides);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

async function expectDiscoveryOpenButExecutionClosed(server: ITestServer) {
  const list = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(list.status).toBe(200);
  expect(await list.text()).toContain('glomo_api_search');

  const search = await callTool(server.url, 'glomo_api_search', { query: 'payout' });
  expect(isRefused(search)).toBe(false);

  const readScope = nock(API_BASE).get(/.*/).reply(200, {});
  const read = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_1' } }, jwt('sandbox'));
  expect(isRefused(read)).toBe(true);
  expect(readScope.isDone()).toBe(false);

  const writeScope = nock(API_BASE).post(/.*/).reply(201, {});
  const write = await callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, jwt('sandbox'));
  expect(isRefused(write)).toBe(true);
  expect(writeScope.isDone()).toBe(false);
}

describe('credential verification configuration', () => {
  it('fails execution closed when verification is not configured, while discovery still answers', async () => {
    await withServer({ authPublicKey: undefined, authAudience: undefined }, expectDiscoveryOpenButExecutionClosed);
  });

  it('fails execution closed when the key is set but the audience is unset', async () => {
    await withServer({ authPublicKey: TEST_PUBLIC_KEY, authAudience: undefined }, expectDiscoveryOpenButExecutionClosed);
  });
});
