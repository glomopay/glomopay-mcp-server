import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { TRateLimiter } from '@/core/telemetry/telemetry.module';
import type { CredentialVerifier } from '@/features/auth/auth.module';
import { logger } from '@/shared/logger/logger.module';
import type { TToolName } from '@/shared/tool/tool.module';

import { AddressRanges, normalizeAddress } from './client-address';
import { JSON_RPC_TRANSPORT_ERROR, type TReject } from './json-rpc-errors';

const WINDOW_MS = 60_000;

const EXECUTION_TOOLS: ReadonlySet<string> = new Set<TToolName>(['glomo_api_read', 'glomo_api_write']);

export interface IRateLimitConfig {
  /** Flood guard: every request to /mcp, per client address (IPv6 grouped by /56), verified or not. */
  floodPerMinute: number;
  /** Callers without a verified credential, per client address. */
  perMinute: number;
  /** Callers with a verified credential, per merchant (the credential's `sub`), whatever their address. */
  merchantPerMinute: number;
  /** glomo_api_read/glomo_api_write calls, per merchant (per client address without a verified credential). */
  executionPerMinute: number;
  /** Client addresses that many users share (e.g. a hosted MCP client's egress); they get `sharedEgressPerMinute` instead. */
  sharedEgressCidrs: readonly string[];
  sharedEgressPerMinute: number;
}

/** The JSON-RPC messages of a request that passed the envelope check (see `request-envelope.ts`). */
export function messagesOf(res: Response): JSONRPCMessage[] {
  return (res.locals.messages as JSONRPCMessage[] | undefined) ?? [];
}

/** The merchant behind a credential that passed `CredentialVerifier`; undefined for none, or one that failed. */
function verifiedMerchant(res: Response): string | undefined {
  return res.locals.verifiedMerchant as string | undefined;
}

function isExecutionCall(message: JSONRPCMessage): boolean {
  if (!('method' in message) || message.method !== 'tools/call') return false;
  const name = (message.params as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && EXECUTION_TOOLS.has(name);
}

/**
 * Verifies the bearer, if any, with the same `CredentialVerifier` the dispatcher uses, and records only
 * the verified merchant for the limiters. An absent, invalid or unverifiable credential leaves none,
 * so the caller is budgeted by address and a made-up token never earns a bucket of its own.
 */
export function identifyCaller(verifier: CredentialVerifier): RequestHandler {
  return async (req, res, next) => {
    if (req.auth?.token) {
      try {
        const result = await verifier.resolve({ authInfo: req.auth });
        if (result.status === 'valid' && result.credential.sub) res.locals.verifiedMerchant = result.credential.sub;
      } catch {
        // A verification failure budgets the caller by address, like any unverified credential.
      }
    }
    next();
  };
}

/** A verified merchant is one budget wherever it calls from; anyone else is budgeted by address. */
function callerKey(req: Request, res: Response): string {
  const merchant = verifiedMerchant(res);
  return merchant ? `merchant:${merchant}` : `address:${ipKeyGenerator(normalizeAddress(req.ip) ?? '')}`;
}

/** express-rate-limit's configuration warnings (e.g. a permissive trust proxy) go through the structured logger. */
const limiterLogger = {
  warn: (error: unknown) => logger.warn('rate limiter configuration warning', { component: 'http', code: errorCode(error) }),
  error: (error: unknown) => logger.error('rate limiter error', { component: 'http', code: errorCode(error) }),
};

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown';
}

function rejectWith(reject: TReject, limiter: TRateLimiter) {
  return (_req: Request, res: Response) => {
    const retryAfter = Number(res.getHeader('Retry-After')) || Math.ceil(WINDOW_MS / 1000);
    reject(
      res,
      { status: 429, code: JSON_RPC_TRANSPORT_ERROR, message: `Too Many Requests: retry after ${retryAfter} seconds`, reason: 'rate_limited' },
      limiter,
    );
  };
}

const SHARED_OPTIONS = {
  windowMs: WINDOW_MS,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  logger: limiterLogger,
} as const;

/**
 * The flood guard: counts every request to /mcp per address before the body is read, so malformed and
 * oversized bodies spend it too, and caps what any one address sends however many merchants it carries.
 */
export function floodRateLimit(config: IRateLimitConfig, reject: TReject): RequestHandler {
  const sharedEgress = new AddressRanges(config.sharedEgressCidrs);
  return rateLimit({
    ...SHARED_OPTIONS,
    identifier: 'flood',
    limit: (req) => (sharedEgress.has(req.ip) ? Math.max(config.sharedEgressPerMinute, config.floodPerMinute) : config.floodPerMinute),
    handler: rejectWith(reject, 'flood'),
  });
}

/** Every request, per verified merchant, or per address without one; mounted after `identifyCaller`. */
export function callerRateLimit(config: IRateLimitConfig, reject: TReject): RequestHandler {
  const sharedEgress = new AddressRanges(config.sharedEgressCidrs);
  return rateLimit({
    ...SHARED_OPTIONS,
    identifier: 'caller',
    limit: (req, res) => {
      if (verifiedMerchant(res)) return config.merchantPerMinute;
      return sharedEgress.has(req.ip) ? config.sharedEgressPerMinute : config.perMinute;
    },
    keyGenerator: callerKey,
    handler: rejectWith(reject, 'caller'),
  });
}

/** Only requests that call an execution tool, keyed like `callerRateLimit`; mounted after `identifyCaller`. */
export function executionRateLimit(config: IRateLimitConfig, reject: TReject): RequestHandler {
  return rateLimit({
    ...SHARED_OPTIONS,
    identifier: 'execution',
    limit: config.executionPerMinute,
    skip: (_req, res) => !messagesOf(res).some(isExecutionCall),
    keyGenerator: callerKey,
    handler: rejectWith(reject, 'execution'),
  });
}
