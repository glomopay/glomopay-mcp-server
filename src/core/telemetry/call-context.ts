import { AsyncLocalStorage } from 'node:async_hooks';

import type { IVerifiedCredential } from '@/features/auth/auth.module';

import type { TErrorCode } from './error-code';

/** The claims attribution may use. They only ever come from a credential that passed verification. */
export type TVerifiedCaller = Pick<IVerifiedCredential, 'sub' | 'env'>;

/**
 * What a tool reports about the call it is serving. Only these fields exist: tool
 * arguments, request bodies and response bodies have no place here.
 */
export interface IToolCallDetails {
  operationId?: string;
  httpStatus?: number;
  resultCount?: number;
  /** Raw search text; redacted before it leaves the process. */
  searchQuery?: string;
  errorCode?: TErrorCode;
  downstreamRequestId?: string;
  /** The operation's path template (e.g. `/api/v1/payouts/{id}`), never the concrete path. */
  pathTemplate?: string;
  /**
   * Set where the credential is verified: the verified caller, or null when the
   * credential was absent or failed verification. Unset: nothing verified it this call.
   */
  caller?: TVerifiedCaller | null;
}

const storage = new AsyncLocalStorage<IToolCallDetails>();

export function runWithToolCall<T>(details: IToolCallDetails, run: () => T): T {
  return storage.run(details, run);
}

export function currentToolCall(): Readonly<IToolCallDetails> | undefined {
  return storage.getStore();
}

/** Adds to the current tool call's details. Outside a tools/call it does nothing. */
export function reportToolCall(details: IToolCallDetails): void {
  const current = storage.getStore();
  if (current) Object.assign(current, details);
}
