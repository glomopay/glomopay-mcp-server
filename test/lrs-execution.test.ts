import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';

import { API_BASE, callTool, isRefused, jwt, startTestServer, type ITestServer } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer({ specPath: DISCOVERY_SPEC });
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
  await server.close();
});

const SANDBOX = () => jwt('sandbox');

describe('LRS operations on the execution allowlist', () => {
  it('lists the LRS banks with glomo_api_read', async () => {
    const scope = nock(API_BASE).get('/api/v1/lrs/banks').reply(200, {});
    const response = await callTool(server.url, 'glomo_api_read', { operationId: 'getLrsBanks', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('creates an LRS quote with glomo_api_write, sending the body as given', async () => {
    const body = { bank_code: 'hdfc', source_amount: 4400000, source_currency: 'INR', target_currency: 'USD' };
    const scope = nock(API_BASE).post('/api/v1/lrs/quotes', body).reply(201, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'createLrsQuote', params: body }, SANDBOX());
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('registers an LRS customer bank account, with the customer id in the path only', async () => {
    const body = { bank_code: 'hdfc', account_number: '000000000000', bank_customer_id: 'test-bank-customer' };
    const scope = nock(API_BASE).post('/api/v1/customer/cust_000000000000/bank_account', body).reply(201, {});
    const response = await callTool(
      server.url,
      'glomo_api_write',
      { operationId: 'createLrsCustomerBankAccount', params: { id: 'cust_000000000000', ...body } },
      SANDBOX(),
    );
    expect(isRefused(response)).toBe(false);
    expect(scope.isDone()).toBe(true);
  });

  it('still refuses createDocument, which is multipart and off the allowlist, without calling the API', async () => {
    const scope = nock(API_BASE).post(/.*/).reply(201, {});
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'createDocument', params: {} }, SANDBOX());
    expect(isRefused(response)).toBe(true);
    expect(scope.isDone()).toBe(false);
  });
});
