import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';

import {
  API_BASE,
  callTool,
  isRecording,
  isRefused,
  jwt,
  resultText,
  SANDBOX_TOKEN,
  startTestServer,
  TEST_AUDIENCE,
  TEST_PUBLIC_KEY,
  withCassette,
  type ITestServer,
} from './helpers';

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer();
});

beforeEach(() => {
  if (!isRecording) {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  }
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(async () => {
  nock.enableNetConnect();
  await server.close();
});

const SANDBOX = () => jwt('sandbox');

const CUSTOMER_BODY = {
  name: 'MCP Test Customer',
  customer_type: 'individual',
  email: 'mcp-test@example.com',
  address: '1 Test Street',
  city: 'Bengaluru',
  state: 'Karnataka',
  country: 'IND',
};

describe('endpoint auth', () => {
  it('lists tools without a bearer', async () => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('glomo_api_search');
  });

  it('serves a discovery tool without a bearer', async () => {
    const response = await callTool(server.url, 'glomo_api_search', { query: 'payout' });
    expect(isRefused(response)).toBe(false);
  });

  it('refuses a read without a credential, without calling the API', async () => {
    const scope = nock(API_BASE).get(/.*/).reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_1' } });
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('Unauthorized');
    expect(scope.isDone()).toBe(false);
  });

  it('refuses a write without a credential, without calling the API', async () => {
    const scope = nock(API_BASE).post(/.*/).reply(201, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY });
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('Unauthorized');
    expect(scope.isDone()).toBe(false);
  });

  it('never lends a credential to a request that carries none', async () => {
    const authed = nock(API_BASE).get('/api/v1/payouts/pay_a').delay(50).reply(200, { id: 'pay_a' });
    const leaked = nock(API_BASE).get('/api/v1/payouts/pay_b').reply(200, { id: 'pay_b' });
    const [, anon] = await Promise.all([
      callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_a' } }, SANDBOX()),
      callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_b' } }),
    ]);
    const after = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_b' } });
    expect(isRefused(anon) && isRefused(after)).toBe(true);
    expect(authed.isDone()).toBe(true);
    expect(leaked.isDone()).toBe(false);
  });
});

describe('request construction', () => {
  it('interpolates a valid path param into the URL', async () => {
    const scope = nock(API_BASE).get('/api/v1/payouts/pay_1').reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_1' } }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('routes declared query params to the query string', async () => {
    const scope = nock(API_BASE).get('/api/v1/customer').query({ page: '2' }).reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getCustomers', params: { page: 2 } }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('sends a POST body built from params', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer', CUSTOMER_BODY).reply(201, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('maps a PATCH to the right method, path and body', async () => {
    const scope = nock(API_BASE).patch('/api/v1/payouts/pay_1/cancel', { reason: 'duplicate' }).reply(200, {});
    const response = await callTool(
      server.url,
      'glomo_api_write',
      { operationId: 'cancelPayout', params: { id: 'pay_1', reason: 'duplicate' } },
      SANDBOX(),
    );
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('maps a DELETE to the right method, path and query params', async () => {
    const scope = nock(API_BASE).delete('/api/v1/virtual-accounts').query({ payment_type: 'bank_transfer', currency: 'USD' }).reply(200, {});
    const response = await callTool(
      server.url,
      'glomo_api_write',
      { operationId: 'closeVirtualAccount', params: { payment_type: 'bank_transfer', currency: 'USD' } },
      SANDBOX(),
    );
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('forwards the caller credential as a Bearer token downstream', async () => {
    const token = jwt('sandbox');
    const scope = nock(API_BASE, { reqheaders: { authorization: `Bearer ${token}` } })
      .get('/api/v1/payouts/pay_9')
      .reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_9' } }, token);
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });
});

describe('path parameter validation', () => {
  for (const badValue of ['.', '..', 'a/b', '']) {
    it(`refuses id "${badValue}" without calling the API`, async () => {
      const scope = nock(API_BASE).get(/.*/).reply(200, {});
      const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: badValue } }, SANDBOX());
      expect(isRefused(response)).toBe(true);
      expect(scope.isDone()).toBe(false);
    });
  }

  it('refuses a missing path param', async () => {
    const scope = nock(API_BASE).get(/.*/).reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });

  it('refuses a non-string path param', async () => {
    const scope = nock(API_BASE).get(/.*/).reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 123 } }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });
});

describe('allowlist and read/write split', () => {
  it('refuses a non-allowlisted operationId without calling its route', async () => {
    const scope = nock(API_BASE).post('/api/v1/platform/merchants').reply(201, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'onboardMerchant', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });

  it('refuses a write operationId through the read tool without calling its route', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'createCustomer', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });

  it('refuses a read operationId through the write tool without calling its route', async () => {
    const scope = nock(API_BASE).get('/api/v1/customer').reply(200, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'getCustomers', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });
});

describe('sandbox-only write guard', () => {
  it('allows a write with a sandbox credential', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, jwt('sandbox'));
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  for (const [label, bearer] of [
    ['production', jwt('production')],
    ['missing env claim', jwt()],
  ] as const) {
    it(`refuses a write with a ${label} credential without calling the API`, async () => {
      const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
      const response = await callTool(server.url, 'glomo_api_write', { operationId: 'createCustomer', params: CUSTOMER_BODY }, bearer);
      expect(isRefused(response)).toBe(true);
      expect(resultText(response)).toContain('sandbox-only');
      expect(scope.isDone()).toBe(false);
    });
  }
});

describe('agent credential verification', () => {
  const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const foreignKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  function signRs256(privateKey: crypto.KeyObject, payload: object): string {
    const input = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  }

  const claims = () => ({ aud: TEST_AUDIENCE, scope: 'both', env: 'sandbox', iat: 0, exp: Math.floor(Date.now() / 1000) + 3600 });

  async function readWith(bearer: string) {
    const scope = nock(API_BASE).get('/api/v1/payouts/pay_1').reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_1' } }, bearer);
    return { response, called: scope.isDone() };
  }

  it('refuses a malformed (non-JWT) credential without calling the API', async () => {
    const { response, called } = await readWith('not-a-jwt');
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('Unauthorized');
    expect(called).toBe(false);
  });

  it('refuses a token whose audience is not the MCP audience (a merchant external-API key)', async () => {
    const { response, called } = await readWith(jwt('sandbox', { aud: 'glomo-external-api' }));
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('Unauthorized');
    expect(called).toBe(false);
  });

  it('refuses a tampered token', async () => {
    const [header, payload, signature] = jwt('sandbox').split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const tampered = `${header}.${b64url({ ...forged, scope: 'both', injected: true })}.${signature}`;
    const { response, called } = await readWith(tampered);
    expect(isRefused(response)).toBe(true);
    expect(called).toBe(false);
  });

  it('refuses an HS256 token signed with the public key (alg confusion)', async () => {
    const input = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims())}`;
    const forged = `${input}.${crypto.createHmac('sha256', TEST_PUBLIC_KEY).update(input).digest('base64url')}`;
    const { response, called } = await readWith(forged);
    expect(isRefused(response)).toBe(true);
    expect(called).toBe(false);
  });

  it('refuses a token signed by a key that is not the configured one', async () => {
    const { response, called } = await readWith(signRs256(foreignKey.privateKey, claims()));
    expect(isRefused(response)).toBe(true);
    expect(called).toBe(false);
  });

  it('blocks a read-only credential on a write tool without calling the API', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
    const response = await callTool(
      server.url,
      'glomo_api_write',
      { operationId: 'createCustomer', params: CUSTOMER_BODY },
      jwt('sandbox', { scope: 'read' }),
    );
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('scope');
    expect(scope.isDone()).toBe(false);
  });

  it('blocks a write-only credential on a read tool without calling the API', async () => {
    const scope = nock(API_BASE).get('/api/v1/payouts/pay_1').reply(200, {});
    const response = await callTool(
      server.url,
      'glomo_api_read',
      { operationId: 'getPayoutById', params: { id: 'pay_1' } },
      jwt('sandbox', { scope: 'write' }),
    );
    expect(isRefused(response)).toBe(true);
    expect(resultText(response)).toContain('scope');
    expect(scope.isDone()).toBe(false);
  });

  it('allows a read with a read-only credential', async () => {
    const { response, called } = await readWith(jwt('sandbox', { scope: 'read' }));
    expect(isRefused(response)).toBe(false);
    expect(called).toBe(true);
  });

  it('allows a write with a write-only sandbox credential', async () => {
    const scope = nock(API_BASE).post('/api/v1/customer').reply(201, {});
    const response = await callTool(
      server.url,
      'glomo_api_write',
      { operationId: 'createCustomer', params: CUSTOMER_BODY },
      jwt('sandbox', { scope: 'write' }),
    );
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });
});

describe('recorded downstream responses', () => {
  it('returns the real status and error body for an unknown payout (404)', async () => {
    await withCassette('get-payout-by-id-404.json', async () => {
      const response = await callTool(
        server.url,
        'glomo_api_read',
        { operationId: 'getPayoutById', params: { id: 'payout_000000000000000000000000' } },
        SANDBOX_TOKEN,
      );
      expect(isRefused(response)).toBe(true);
      expect(resultText(response)).toContain('"statusCode":404');
      expect(resultText(response)).toContain('Payout not found');
    });
  });
});

describe('per-request isolation', () => {
  it('forwards each concurrent request its own credential and response', async () => {
    const tokenA = jwt('sandbox', { sub: 'merchant-a' });
    const tokenB = jwt('sandbox', { sub: 'merchant-b' });

    const scopeA = nock(API_BASE, { reqheaders: { authorization: `Bearer ${tokenA}` } })
      .get('/api/v1/payouts/pay_a')
      .delay(50)
      .reply(200, { id: 'pay_a' });
    const scopeB = nock(API_BASE, { reqheaders: { authorization: `Bearer ${tokenB}` } })
      .get('/api/v1/payouts/pay_b')
      .reply(200, { id: 'pay_b' });

    const [first, second] = await Promise.all([
      callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_a' } }, tokenA),
      callTool(server.url, 'glomo_api_read', { operationId: 'getPayoutById', params: { id: 'pay_b' } }, tokenB),
    ]);

    expect(resultText(first)).toContain('pay_a');
    expect(resultText(first)).not.toContain('pay_b');
    expect(resultText(second)).toContain('pay_b');
    expect(resultText(second)).not.toContain('pay_a');
    expect(scopeA.isDone() && scopeB.isDone()).toBe(true);
  });
});
