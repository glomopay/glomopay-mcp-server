import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';

import { callTool, isRefused, resultText, startTestServer, type ITestServer } from './helpers';

const DISCOVERY_SPEC = path.resolve(__dirname, 'fixtures/openapi-discovery.json');

let server: ITestServer;

beforeAll(async () => {
  server = await startTestServer({ specPath: DISCOVERY_SPEC });
  nock.enableNetConnect('127.0.0.1');
});

afterAll(async () => {
  nock.disableNetConnect();
  await server.close();
});

interface ISearchResult {
  operationId: string;
  method: string;
  executable: boolean;
  tool?: string;
  path: string;
}
interface IDetailsEntry {
  operationId: string;
  method?: string;
  executable?: boolean;
  tool?: string;
  error?: string;
  parameters?: { name: string; example?: unknown; schema?: Record<string, unknown> }[];
}

function search(query: string, limit?: number) {
  return callTool(server.url, 'glomo_api_search', limit === undefined ? { query } : { query, limit }, 'test');
}
function details(operationIds: string[]) {
  return callTool(server.url, 'glomo_api_details', { operationIds }, 'test');
}
async function searchResults(query: string, limit?: number): Promise<ISearchResult[]> {
  return (JSON.parse(resultText(await search(query, limit))) as { results: ISearchResult[] }).results;
}
async function detailsPayload(operationIds: string[]) {
  return JSON.parse(resultText(await details(operationIds))) as { operations: IDetailsEntry[]; omitted?: string[] };
}

describe('glomo_api_search', () => {
  it('ranks a beneficiary operation first for a beneficiary query', async () => {
    expect((await searchResults('beneficiary'))[0].operationId).toMatch(/Beneficiary/);
  });

  it('ranks cancelPayout first for a cancel-payout query', async () => {
    expect((await searchResults('cancel payout'))[0].operationId).toBe('cancelPayout');
  });

  it('indexes operation descriptions', async () => {
    expect((await searchResults('mutually exclusive'))[0].operationId).toBe('getPayments');
  });

  it('indexes top-level request body property names', async () => {
    const ids = (await searchResults('category')).map((result) => result.operationId);
    expect(ids).toContain('createBeneficiaryV2');
  });

  it('filters out zero-score results', async () => {
    expect(await searchResults('zzzquux')).toHaveLength(0);
  });

  it('honours the limit', async () => {
    expect((await searchResults('payout')).length).toBeGreaterThan(1);
    expect(await searchResults('payout', 1)).toHaveLength(1);
  });

  it('tags each executable result with its execution tool', async () => {
    const results = await searchResults('beneficiary');
    for (const result of results) {
      if (result.executable) expect(result.tool).toBe(result.method === 'GET' ? 'glomo_api_read' : 'glomo_api_write');
      else expect(result.tool).toBeUndefined();
    }
  });

  it('surfaces a non-executable operation flagged executable:false', async () => {
    const result = (await searchResults('rotate api key')).find((entry) => entry.operationId === 'rotateApiKey');
    expect(result).toBeDefined();
    expect(result?.executable).toBe(false);
    expect(result?.tool).toBeUndefined();
  });

  it('refuses an empty query', async () => {
    expect(isRefused(await search(''))).toBe(true);
  });

  it('refuses a query above the maximum length', async () => {
    expect(isRefused(await search('a'.repeat(201)))).toBe(true);
  });

  it('refuses a limit above the maximum', async () => {
    expect(isRefused(await search('payout', 26))).toBe(true);
  });
});

describe('glomo_api_details', () => {
  it('resolves $refs so the output carries no $ref', async () => {
    expect(resultText(await details(['createPayout']))).not.toContain('"$ref"');
  });

  it('returns deeply nested fields intact, without truncation', async () => {
    const text = resultText(await details(['getPayments']));
    expect(text).toContain('fee_breakdown');
    expect(text).not.toContain('$truncated');
  });

  it('returns a recursive schema without throwing', async () => {
    const response = await details(['cancelPayout']);
    expect(isRefused(response)).toBe(false);
    expect(resultText(response)).toContain('$circular');
  });

  it('strips x-* schema extensions', async () => {
    expect(resultText(await details(['cancelPayout']))).not.toContain('x-internal');
  });

  it('includes request and response examples', async () => {
    expect(resultText(await details(['createPayout']))).toContain('payout_without_quote');
    expect(resultText(await details(['createBeneficiaryV2']))).toContain('missing_category');
  });

  it('returns the full parameter schema and parameter-level example', async () => {
    const entry = (await detailsPayload(['getPayments'])).operations.find((op) => op.operationId === 'getPayments');
    const perPage = entry?.parameters?.find((param) => param.name === 'per_page');
    expect(perPage?.schema?.default).toBe(20);
    const currency = entry?.parameters?.find((param) => param.name === 'currency');
    expect(currency?.schema?.format).toBeDefined();
    const customerId = entry?.parameters?.find((param) => param.name === 'customer_id');
    expect(customerId?.example).toBeDefined();
  });

  it('tags each executable entry with its execution tool', async () => {
    const payload = await detailsPayload(['getCustomers', 'createPayout']);
    expect(payload.operations.find((op) => op.operationId === 'getCustomers')?.tool).toBe('glomo_api_read');
    expect(payload.operations.find((op) => op.operationId === 'createPayout')?.tool).toBe('glomo_api_write');
  });

  it('returns full detail for a non-executable operation flagged executable:false', async () => {
    const entry = (await detailsPayload(['rotateApiKey'])).operations.find((op) => op.operationId === 'rotateApiKey');
    expect(entry?.error).toBeUndefined();
    expect(entry?.executable).toBe(false);
    expect(entry?.tool).toBeUndefined();
    expect(entry?.method).toBeDefined();
  });

  it('reports a genuinely unknown operationId as unknown', async () => {
    const entry = (await detailsPayload(['doesNotExist'])).operations.find((op) => op.operationId === 'doesNotExist');
    expect(entry?.error).toMatch(/unknown/i);
  });

  it('keeps a non-executable operation out of the write tool', async () => {
    const response = await callTool(server.url, 'glomo_api_write', { operationId: 'rotateApiKey', params: {} }, 'test');
    expect(isRefused(response)).toBe(true);
  });

  it('de-duplicates operationIds', async () => {
    const payload = await detailsPayload(['getCustomers', 'getCustomers']);
    expect(payload.operations).toHaveLength(1);
  });

  it('bounds the response size with a byte budget', async () => {
    const payload = await detailsPayload(['getPayments', 'createPayout']);
    expect(payload.omitted).toContain('createPayout');
    expect(payload.operations.map((op) => op.operationId)).not.toContain('createPayout');
  });

  it('refuses an empty operationIds array', async () => {
    expect(isRefused(await details([]))).toBe(true);
  });

  it('refuses more than ten operationIds', async () => {
    expect(isRefused(await details(Array.from({ length: 11 }, (_, i) => `op${i}`)))).toBe(true);
  });

  it('refuses an operationId above the maximum length', async () => {
    expect(isRefused(await details(['a'.repeat(101)]))).toBe(true);
  });
});
