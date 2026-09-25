export const ERROR_CODES = [
  'validation_error',
  'unknown_operation',
  'auth_missing',
  'auth_invalid',
  'auth_rejected',
  'upstream_4xx',
  'upstream_5xx',
  'timeout',
  'internal',
] as const;

export type TErrorCode = (typeof ERROR_CODES)[number];

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

/** Classifies a failed downstream glomo call by its HTTP status, or its transport error when there is none. */
export function errorCodeForUpstream({ statusCode, code }: { statusCode?: number; code?: string }): TErrorCode {
  if (statusCode === 401 || statusCode === 403) return 'auth_rejected';
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) return 'upstream_4xx';
  if (statusCode !== undefined && statusCode >= 500) return 'upstream_5xx';
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  return 'internal';
}
