import { describe, expect, it } from 'vitest';

import { resolveCredential } from '@/features/auth/auth.module';
import type { TToolExtra } from '@/shared/tool/tool.module';

describe('resolveCredential', () => {
  it('returns the bearer token from authInfo', () => {
    const extra = { authInfo: { token: 'secret-token' } } as unknown as TToolExtra;
    expect(resolveCredential(extra)).toBe('secret-token');
  });

  it('returns undefined when no token is present', () => {
    expect(resolveCredential({} as unknown as TToolExtra)).toBeUndefined();
  });
});
