import { importSPKI, jwtVerify } from 'jose';

import { TToolExtra } from '@/shared/tool/tool.module';

type TVerificationKey = Awaited<ReturnType<typeof importSPKI>>;

export interface IVerifiedCredential {
  token: string;
  env?: string;
  sub?: string;
}

export type TCredentialResult = { status: 'absent' } | { status: 'invalid'; reason: string } | { status: 'valid'; credential: IVerifiedCredential };

export interface ICredentialVerifierConfig {
  publicKeyPem?: string;
  audience?: string;
}

const CLOCK_TOLERANCE_SECONDS = 30;
// `iss` is not checked: `aud` = the MCP audience alone identifies the credential,
// and a merchant's external-API key carries the external-API audience instead.

function readToken(extra: TToolExtra): string | undefined {
  return extra.authInfo?.token;
}

// Env dashboards commonly store a PEM with literal backslash-n rather than real newlines.
function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

export class CredentialVerifier {
  private key?: Promise<TVerificationKey>;

  constructor(private config: ICredentialVerifierConfig) {}

  private isConfigured(): boolean {
    return Boolean(this.config.publicKeyPem && this.config.audience);
  }

  private getKey(): Promise<TVerificationKey> {
    if (!this.config.publicKeyPem) throw new Error('no public key configured');
    if (!this.key) this.key = importSPKI(normalizePem(this.config.publicKeyPem), 'RS256');
    return this.key;
  }

  async resolve(extra: TToolExtra): Promise<TCredentialResult> {
    const token = readToken(extra);
    if (!token) return { status: 'absent' };

    if (!this.isConfigured()) {
      return { status: 'invalid', reason: 'credential verification is not configured on this server' };
    }

    let env: unknown;
    let sub: unknown;
    try {
      const { payload } = await jwtVerify(token, await this.getKey(), {
        algorithms: ['RS256'],
        audience: this.config.audience,
        requiredClaims: ['exp', 'iat'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      env = payload.env;
      sub = payload.sub;
    } catch {
      return { status: 'invalid', reason: 'invalid credential' };
    }

    return {
      status: 'valid',
      credential: {
        token,
        env: typeof env === 'string' ? env : undefined,
        sub: typeof sub === 'string' ? sub : undefined,
      },
    };
  }
}
