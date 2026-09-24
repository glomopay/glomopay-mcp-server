import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadSpecIndex, type TSpecIndex } from '@/core/dispatcher/dispatcher.module';

const FIXTURE_SPEC = path.resolve(process.cwd(), 'test/fixtures/openapi.json');

let index: TSpecIndex;

beforeAll(async () => {
  index = await loadSpecIndex(FIXTURE_SPEC);
});

describe('loadSpecIndex', () => {
  it('indexes by operationId with method and full versioned path', () => {
    const op = index.get('getCustomers');
    expect(op?.method).toBe('GET');
    expect(op?.path).toBe('/api/v1/customer');
  });

  it('resolves v2 operations to /api/v2 as a sibling, not /api/v1/v2', () => {
    expect(index.get('createBeneficiaryV2')?.path).toBe('/api/v2/beneficiaries');
    expect(index.get('getBeneficiaryByIdV2')?.path).toBe('/api/v2/beneficiaries/{id}');
  });

  it('extracts path params from the path template', () => {
    expect(index.get('getPayoutById')?.pathParams).toEqual(['id']);
    expect(index.get('getBeneficiaryByIdV2')?.pathParams).toEqual(['id']);
    expect(index.get('getCustomers')?.pathParams).toEqual([]);
  });

  it('extracts declared query params', () => {
    expect(index.get('getCustomers')?.queryParams).toContain('page');
    expect(index.get('getPayoutById')?.queryParams).toEqual([]);
  });

  it('returns undefined for an unknown operationId', () => {
    expect(index.get('doesNotExist')).toBeUndefined();
  });
});
