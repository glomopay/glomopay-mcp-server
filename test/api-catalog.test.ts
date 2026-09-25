import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadSpecDocument, buildSpecIndex } from '@/core/dispatcher/dispatcher.module';
import { buildCatalog, ApiCatalog, type ICatalogEntry } from '@/core/catalog/catalog.module';
import { executionAllowlist } from '@/features/allowlist/allowlist.module';

const FIXTURE_SPEC = path.resolve(__dirname, 'fixtures/openapi.json');

let catalog: ApiCatalog;

beforeAll(async () => {
  const parsed = await loadSpecDocument(FIXTURE_SPEC);
  const specIndex = buildSpecIndex(parsed);
  const allowed = [...executionAllowlist].filter((operationId) => specIndex.has(operationId));
  catalog = buildCatalog(parsed, allowed);
});

function ids(results: { operationId: string }[]): string[] {
  return results.map((result) => result.operationId);
}

function isEntry(result: unknown): result is ICatalogEntry {
  return typeof result === 'object' && result !== null && 'method' in result;
}

describe('ApiCatalog search', () => {
  it('ranks a beneficiary operation first for a beneficiary query', () => {
    const results = catalog.search('beneficiary', 10);
    expect(results[0].operationId).toMatch(/Beneficiary/);
  });

  it('ranks cancelPayout first for a cancel-payout query', () => {
    const results = catalog.search('cancel payout', 10);
    expect(results[0].operationId).toBe('cancelPayout');
  });

  it('matches on description text, not just operationId and summary', () => {
    const results = catalog.search('recipient', 10);
    expect(ids(results)).toContain('createBeneficiaryV2');
    expect(ids(results)).not.toContain('getBeneficiaryByIdV2');
  });

  it('honours the limit', () => {
    const all = catalog.search('customer beneficiary payout', 10);
    expect(all.length).toBeGreaterThan(1);
    expect(catalog.search('customer beneficiary payout', 1)).toHaveLength(1);
  });

  it('returns nothing for a query with no indexable terms', () => {
    expect(catalog.search('   ', 10)).toHaveLength(0);
  });
});

describe('ApiCatalog allowlist scoping', () => {
  it('never surfaces a non-allowlisted operation, even on a query that strongly matches it', () => {
    const results = catalog.search('merchant onboard platform', 10);
    expect(ids(results)).not.toContain('onboardMerchant');
  });

  it('reports a spec operation that is off the callable surface as excluded, not unknown', () => {
    const result = catalog.details('onboardMerchant');
    expect(isEntry(result)).toBe(false);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/not on the discoverable/i);
  });

  it('reports a genuinely unknown operationId distinctly', () => {
    const result = catalog.details('doesNotExist');
    expect((result as { error: string }).error).toMatch(/unknown/i);
  });
});

describe('ApiCatalog details', () => {
  it('returns the request body schema for a write operation', () => {
    const result = catalog.details('createBeneficiaryV2');
    expect(isEntry(result)).toBe(true);
    const entry = result as ICatalogEntry;
    expect(entry.method).toBe('POST');
    expect(entry.path).toBe('/api/v2/beneficiaries');
    const schema = entry.requestBody?.schema as { properties: { currency: { enum: string[] } } };
    expect(schema.properties.currency.enum).toContain('USD');
    expect(entry.responses.map((response) => response.status)).toContain('201');
  });

  it('returns declared parameters for a read operation', () => {
    const entry = catalog.details('getCustomers') as ICatalogEntry;
    const page = entry.parameters.find((param) => param.name === 'page');
    expect(page).toMatchObject({ in: 'query', type: 'integer' });
  });
});
