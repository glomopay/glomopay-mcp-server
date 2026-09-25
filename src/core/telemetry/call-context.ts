import { AsyncLocalStorage } from 'node:async_hooks';

import type { TErrorCode } from './error-code';

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
}

const storage = new AsyncLocalStorage<IToolCallDetails>();

export function runWithToolCall<T>(details: IToolCallDetails, run: () => T): T {
  return storage.run(details, run);
}

/** Adds to the current tool call's details. Outside a tools/call it does nothing. */
export function reportToolCall(details: IToolCallDetails): void {
  const current = storage.getStore();
  if (current) Object.assign(current, details);
}
