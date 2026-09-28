import { describe, expect, it } from 'vitest';

import { CredentialVerifier } from '@/features/auth/auth.module';
import { TEST_AUDIENCE, TEST_PUBLIC_KEY, jwt } from './helpers';

function extra(token?: string) {
  return { authInfo: token ? { token } : undefined } as unknown as Parameters<CredentialVerifier['resolve']>[0];
}

describe('CredentialVerifier', () => {
  it('reports an absent credential when no bearer is present', async () => {
    const verifier = new CredentialVerifier({ publicKeyPem: TEST_PUBLIC_KEY, audience: TEST_AUDIENCE });
    expect(await verifier.resolve(extra())).toEqual({ status: 'absent' });
  });

  it('fails closed when verification is not configured', async () => {
    const verifier = new CredentialVerifier({});
    const result = await verifier.resolve(extra(jwt('sandbox')));
    expect(result.status).toBe('invalid');
  });

  it('returns the verified scope and env for a valid credential', async () => {
    const verifier = new CredentialVerifier({ publicKeyPem: TEST_PUBLIC_KEY, audience: TEST_AUDIENCE });
    const result = await verifier.resolve(extra(jwt('sandbox', { scope: 'read' })));
    expect(result).toMatchObject({ status: 'valid', credential: { scope: 'read', env: 'sandbox' } });
  });
});
