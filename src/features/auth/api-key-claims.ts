import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export type TApiKeyEnv = 'production' | 'sandbox';

/** The only claims the server reads from a glomo API key. */
export interface IApiKeyClaims {
  sub?: string;
  env?: TApiKeyEnv;
}

const SUBJECT_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
const API_KEY_ENVS: readonly string[] = ['production', 'sandbox'];

function decodeSegment(segment: string | undefined): Record<string, unknown> | undefined {
  if (!segment) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function pickClaims(payload: Record<string, unknown>): IApiKeyClaims {
  const { sub, env } = payload;
  return {
    ...(typeof sub === 'string' && SUBJECT_FORMAT.test(sub) ? { sub } : {}),
    ...(typeof env === 'string' && API_KEY_ENVS.includes(env) ? { env: env as TApiKeyEnv } : {}),
  };
}

function hasValidSignature(token: string, publicKey: KeyObject): boolean {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return false;
  if (decodeSegment(header)?.alg !== 'RS256') return false;
  try {
    return verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function isExpired(payload: Record<string, unknown>): boolean {
  return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
}

export function parsePublicKey(pem: string | undefined): KeyObject | undefined {
  if (!pem) return undefined;
  return createPublicKey(pem.replace(/\\n/g, '\n'));
}

/**
 * Reads `sub` and `env` from a glomo API key (an RS256 JWT). With a public key the
 * signature and expiry must hold; without one the claims are decoded as-is.
 * Returns undefined for anything that is not a readable key.
 */
export function readApiKeyClaims(token: string | undefined, publicKey?: KeyObject): IApiKeyClaims | undefined {
  if (!token) return undefined;
  const payload = decodeSegment(token.split('.')[1]);
  if (!payload) return undefined;

  if (publicKey && (!hasValidSignature(token, publicKey) || isExpired(payload))) return undefined;

  return pickClaims(payload);
}
