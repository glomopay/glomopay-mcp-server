import { importSPKI, jwtVerify } from 'jose';

import { TToolExtra } from '@/shared/tool/tool.module';

type TVerificationKey = Awaited<ReturnType<typeof importSPKI>>;

export type TScope = 'read' | 'write' | 'both';

export interface IVerifiedCredential {
  token: string;
  scope: TScope;
  env?: string;
}

export type TCredentialResult = { status: 'absent' } | { status: 'invalid'; reason: string } | { status: 'valid'; credential: IVerifiedCredential };

export interface ICredentialVerifierConfig {
  publicKeyPem?: string;
  audience?: string;
}

const SCOPES: readonly TScope[] = ['read', 'write', 'both'];

function readToken(extra: TToolExtra): string | undefined {
  return extra.authInfo?.token;
}

export class CredentialVerifier {
  private key?: Promise<TVerificationKey>;

  constructor(private config: ICredentialVerifierConfig) {}

  private getKey(): Promise<TVerificationKey> {
    if (!this.config.publicKeyPem) throw new Error('no public key configured');
    if (!this.key) this.key = importSPKI(this.config.publicKeyPem, 'RS256');
    return this.key;
  }

  async resolve(extra: TToolExtra): Promise<TCredentialResult> {
    const token = readToken(extra);
    if (!token) return { status: 'absent' };

    if (!this.config.publicKeyPem || !this.config.audience) {
      return { status: 'invalid', reason: 'credential verification is not configured on this server' };
    }

    let scope: unknown;
    let env: unknown;
    try {
      const { payload } = await jwtVerify(token, await this.getKey(), {
        algorithms: ['RS256'],
        audience: this.config.audience,
      });
      scope = payload.scope;
      env = payload.env;
    } catch (error) {
      return { status: 'invalid', reason: error instanceof Error ? error.message : 'token verification failed' };
    }

    if (typeof scope !== 'string' || !SCOPES.includes(scope as TScope)) {
      return { status: 'invalid', reason: 'credential has no valid scope claim' };
    }

    return {
      status: 'valid',
      credential: { token, scope: scope as TScope, env: typeof env === 'string' ? env : undefined },
    };
  }
}

export function scopePermits(scope: TScope, needed: 'read' | 'write'): boolean {
  return scope === 'both' || scope === needed;
}
