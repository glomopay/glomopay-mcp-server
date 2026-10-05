import { createHash } from 'node:crypto';

import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { TRateLimiter } from '@/core/telemetry/telemetry.module';
import { logger } from '@/shared/logger/logger.module';
import type { TToolName } from '@/shared/tool/tool.module';

import { AddressRanges, normalizeAddress } from './client-address';
import { JSON_RPC_TRANSPORT_ERROR, type TReject } from './json-rpc-errors';

const WINDOW_MS = 60_000;

const EXECUTION_TOOLS: ReadonlySet<string> = new Set<TToolName>(['glomo_api_read', 'glomo_api_write']);

export interface IRateLimitConfig {
  /** Every request to /mcp, per client address (IPv6 grouped by /56). */
  perMinute: number;
  /** glomo_api_read/glomo_api_write calls, per credential (per client address when there is none). */
  executionPerMinute: number;
  /** Client addresses that many users share (e.g. a hosted MCP client's egress); they get `sharedEgressPerMinute` instead. */
  sharedEgressCidrs: readonly string[];
  sharedEgressPerMinute: number;
}

/** The JSON-RPC messages of a request that passed the envelope check (see `request-envelope.ts`). */
export function messagesOf(res: Response): JSONRPCMessage[] {
  return (res.locals.messages as JSONRPCMessage[] | undefined) ?? [];
}

function isExecutionCall(message: JSONRPCMessage): boolean {
  if (!('method' in message) || message.method !== 'tools/call') return false;
  const name = (message.params as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && EXECUTION_TOOLS.has(name);
}

/** Bucket key for an execution call: the credential when one is sent, so one credential is one budget whatever its address. */
function executionKey(req: Request): string {
  const token = req.auth?.token;
  if (token) return `credential:${createHash('sha256').update(token).digest('hex')}`;
  return `address:${ipKeyGenerator(normalizeAddress(req.ip) ?? '')}`;
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

/** Counts every request to /mcp, before the body is read, so malformed and oversized bodies spend the budget too. */
export function overallRateLimit(config: IRateLimitConfig, reject: TReject): RequestHandler {
  const sharedEgress = new AddressRanges(config.sharedEgressCidrs);
  return rateLimit({
    ...SHARED_OPTIONS,
    identifier: 'overall',
    limit: (req) => (sharedEgress.has(req.ip) ? config.sharedEgressPerMinute : config.perMinute),
    handler: rejectWith(reject, 'overall'),
  });
}

/** Counts only requests that call an execution tool; mounted after the body is parsed and the bearer is read. */
export function executionRateLimit(config: IRateLimitConfig, reject: TReject): RequestHandler {
  return rateLimit({
    ...SHARED_OPTIONS,
    identifier: 'execution',
    limit: config.executionPerMinute,
    skip: (_req, res) => !messagesOf(res).some(isExecutionCall),
    keyGenerator: executionKey,
    handler: rejectWith(reject, 'execution'),
  });
}
