import { metrics, type Counter } from '@opentelemetry/api';

import { SERVICE_NAME } from './otel';

/** Why a request was turned away before it reached the MCP transport. */
export type TRejectionReason =
  | 'rate_limited'
  | 'parse_error'
  | 'invalid_request'
  | 'batch_unsupported'
  | 'body_too_large'
  | 'unsupported_media_type'
  | 'bad_request'
  | 'internal';

export type TRateLimiter = 'flood' | 'caller' | 'execution';

export interface IHttpMetrics {
  /** Attributes are `reason` and, for `rate_limited`, `limiter`. Never the client address, credential or path. */
  rejected: Counter;
}

/** Instruments are created from the global meter, so call this after telemetry has started. */
export function createHttpMetrics(): IHttpMetrics {
  const meter = metrics.getMeter(SERVICE_NAME);
  return {
    rejected: meter.createCounter('mcp.http.rejected', { description: 'Requests rejected before the MCP transport, by reason and limiter' }),
  };
}
