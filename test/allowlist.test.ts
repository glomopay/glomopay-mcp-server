import { describe, expect, it } from 'vitest';

import { EXECUTION_ALLOWLIST, executionAllowlist } from '@/features/allowlist/allowlist.module';

const DROPPED_IN_REVIEW = ['rotateApiKey', 'createDocument', 'updateRfiPayout', 'onboardMerchant', 'updateMerchant', 'updateMerchantStatus'];

describe('execution allowlist', () => {
  it('excludes the operations dropped in review', () => {
    for (const operationId of DROPPED_IN_REVIEW) {
      expect(executionAllowlist.has(operationId)).toBe(false);
    }
  });

  it('keeps getMerchant', () => {
    expect(executionAllowlist.has('getMerchant')).toBe(true);
  });

  it('has no duplicate entries', () => {
    expect(executionAllowlist.size).toBe(EXECUTION_ALLOWLIST.length);
  });

  it('holds the reviewed operation count', () => {
    expect(EXECUTION_ALLOWLIST.length).toBe(77);
  });
});
