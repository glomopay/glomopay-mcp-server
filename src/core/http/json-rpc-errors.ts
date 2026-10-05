import type { ErrorRequestHandler, Response } from 'express';

import type { IHttpMetrics, TRateLimiter, TRejectionReason } from '@/core/telemetry/telemetry.module';
import { logger } from '@/shared/logger/logger.module';

/** JSON-RPC codes, matching the MCP SDK's own transport errors. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_INTERNAL_ERROR = -32603;
/** Implementation-defined; the SDK uses it for transport-level (HTTP) rejections. */
export const JSON_RPC_TRANSPORT_ERROR = -32000;

export interface IRejection {
  status: number;
  code: number;
  message: string;
  reason: TRejectionReason;
}

export type TReject = (res: Response, rejection: IRejection, limiter?: TRateLimiter) => void;

/**
 * Writes a JSON-RPC error with no id, the shape the MCP Streamable HTTP transport allows for a
 * POST the server cannot accept. Never carries an error message, stack or `data` from the cause.
 */
export function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('application/json')
    .send(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Sends the rejection and counts it in `mcp.http.rejected`. Nothing reaches analytics. */
export function createRejecter(metrics: IHttpMetrics): TReject {
  return (res, { status, code, message, reason }, limiter) => {
    metrics.rejected.add(1, limiter ? { reason, limiter } : { reason });
    sendJsonRpcError(res, status, code, message);
  };
}

interface IBodyParserError {
  type?: unknown;
  status?: unknown;
  name?: unknown;
}

export const PARSE_ERROR: IRejection = { status: 400, code: JSON_RPC_PARSE_ERROR, message: 'Parse error', reason: 'parse_error' };

function rejectionFor(error: IBodyParserError, bodyLimitKb: number): IRejection | undefined {
  switch (error.type) {
    case 'entity.parse.failed':
      return PARSE_ERROR;
    case 'entity.too.large':
      return {
        status: 413,
        code: JSON_RPC_TRANSPORT_ERROR,
        message: `Payload Too Large: the request body exceeds ${bodyLimitKb} KB`,
        reason: 'body_too_large',
      };
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return { status: 415, code: JSON_RPC_TRANSPORT_ERROR, message: 'Unsupported Media Type', reason: 'unsupported_media_type' };
  }
  const status = typeof error.status === 'number' ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    return { status, code: JSON_RPC_TRANSPORT_ERROR, message: 'Bad Request', reason: 'bad_request' };
  }
  return undefined;
}

/**
 * The last middleware: turns body-parser and any other unhandled error into a JSON-RPC error,
 * whatever NODE_ENV is, and logs only the error's name for anything unexpected.
 */
export function jsonRpcErrorHandler(reject: TReject, bodyLimitKb: number): ErrorRequestHandler {
  // Express recognises an error handler by its four parameters, so `_next` stays although it is unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error: unknown, req, res, _next) => {
    if (res.headersSent) {
      req.socket.destroy();
      return;
    }
    const known = error && typeof error === 'object' ? rejectionFor(error as IBodyParserError, bodyLimitKb) : undefined;
    if (known) {
      reject(res, known);
      return;
    }
    logger.error('unhandled http error', { component: 'http', errorName: error instanceof Error ? error.name : typeof error });
    reject(res, { status: 500, code: JSON_RPC_INTERNAL_ERROR, message: 'Internal error', reason: 'internal' });
  };
}
