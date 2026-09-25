import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, isRefused, resultText, startTestServer, type ITestServer } from './helpers';

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer();
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
});

function search(args: { query: string; limit?: number }) {
  return callTool(server.url, 'glomopay_api_search', args, 'test');
}

function details(operationIds: string[]) {
  return callTool(server.url, 'glomopay_api_details', { operationIds }, 'test');
}

describe('glomopay_api_search', () => {
  it('returns ranked matches for a keyword', async () => {
    const payload = JSON.parse(resultText(await search({ query: 'beneficiary' }))) as {
      results: { operationId: string; method: string; path: string }[];
    };
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].operationId).toMatch(/Beneficiary/);
    expect(payload.results.map((result) => result.operationId)).not.toContain('onboardMerchant');
  });

  it('refuses an empty query', async () => {
    expect(isRefused(await search({ query: '' }))).toBe(true);
  });

  it('refuses a query above the maximum length', async () => {
    expect(isRefused(await search({ query: 'a'.repeat(201) }))).toBe(true);
  });
});

describe('glomopay_api_details', () => {
  it('returns full detail for known operations and flags excluded ones', async () => {
    const payload = JSON.parse(resultText(await details(['createBeneficiaryV2', 'onboardMerchant']))) as {
      operations: { operationId: string; method?: string; requestBody?: unknown; error?: string }[];
    };

    const beneficiary = payload.operations.find((op) => op.operationId === 'createBeneficiaryV2');
    expect(beneficiary?.method).toBe('POST');
    expect(beneficiary?.requestBody).toBeDefined();

    const merchant = payload.operations.find((op) => op.operationId === 'onboardMerchant');
    expect(merchant?.error).toMatch(/not on the discoverable/i);
    expect(merchant?.method).toBeUndefined();
  });

  it('refuses an empty operationIds array', async () => {
    expect(isRefused(await details([]))).toBe(true);
  });
});
