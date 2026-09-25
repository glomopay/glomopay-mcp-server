import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { TToolExtra } from '@/shared/tool/tool.module';
import { ApiClient, ApiError, THttpMethod } from '@/shared/api-client/api-client.module';
import { CredentialVerifier } from '@/features/auth/auth.module';
import { errorCodeForUpstream, reportToolCall, type TErrorCode } from '@/core/telemetry/telemetry.module';

import { TSpecIndex } from './spec-index';

function errorResult(text: string, errorCode: TErrorCode): CallToolResult {
  reportToolCall({ errorCode });
  return { content: [{ type: 'text', text }], isError: true };
}

function unknownWriteOutcome(operationId: string, cause: string): string {
  return (
    `The outcome of "${operationId}" is unknown: ${cause}, so the write may or may not have been applied. ` +
    'Before retrying, look the resource up (for example by the request_id you sent, or by listing recent records) to see whether it was created. ' +
    'If you retry, reuse the same request_id; do not retry with a new request_id.'
  );
}

const REQUEST_ID_FORMAT = /^[A-Za-z0-9._:-]{1,128}$/;

function downstreamRequestId(headers: Record<string, unknown> | undefined): string | undefined {
  const value = headers?.['x-request-id'];
  return typeof value === 'string' && REQUEST_ID_FORMAT.test(value) ? value : undefined;
}

export class Dispatcher {
  constructor(
    private specIndex: TSpecIndex,
    private allowlist: ReadonlySet<string>,
    private apiClient: ApiClient,
    private verifier: CredentialVerifier,
  ) {}

  async dispatch(
    operationId: string,
    params: Record<string, unknown> | undefined,
    extra: TToolExtra,
    allowedMethods: readonly THttpMethod[],
  ): Promise<CallToolResult> {
    const operation = this.specIndex.get(operationId);
    if (!operation) {
      return errorResult(`Unknown operationId "${operationId}": not a documented glomo operation.`, 'unknown_operation');
    }
    reportToolCall({ operationId, pathTemplate: operation.path });

    if (!this.allowlist.has(operationId)) {
      return errorResult(`operationId "${operationId}" is not on the execution allowlist and cannot be called.`, 'unknown_operation');
    }

    if (!allowedMethods.includes(operation.method)) {
      return errorResult(
        `operationId "${operationId}" is a ${operation.method} operation; this tool only serves ${allowedMethods.join('/')}. ` +
          `Use ${operation.method === 'GET' ? 'glomo_api_read' : 'glomo_api_write'} instead.`,
        'validation_error',
      );
    }

    const credential = await this.verifier.resolve(extra);
    if (credential.status === 'absent') {
      return errorResult('Unauthorized: no glomo credential supplied for this request.', 'auth_missing');
    }
    if (credential.status === 'invalid') {
      return errorResult(`Unauthorized: ${credential.reason}.`, 'auth_invalid');
    }

    const { token: secret, env } = credential.credential;
    if (env !== 'sandbox') {
      return errorResult(`Refusing "${operationId}": the execution tools are sandbox-only and require a sandbox credential.`);
    }

    // Route from the raw params; the glomo API validates the body. A derived
    // schema would under-model some request bodies and silently drop valid fields.
    const { method } = operation;
    const remaining: Record<string, unknown> = { ...(params ?? {}) };

    for (const name of operation.pathParams) {
      const value = remaining[name];
      if (typeof value !== 'string' || value.trim() === '') {
        return errorResult(`Missing or invalid path parameter "${name}" for "${operationId}": expected a non-empty string.`, 'validation_error');
      }
      if (value === '.' || value === '..' || value.includes('/')) {
        return errorResult(`Invalid path parameter "${name}" for "${operationId}": must be a single safe path segment.`, 'validation_error');
      }
    }

    const url = operation.path.replace(/\{([^}]+)\}/g, (match, key) => {
      if (!(key in remaining)) return match;
      const value = String(remaining[key]);
      delete remaining[key];
      return encodeURIComponent(value);
    });

    if (/\{[^}]+\}/.test(url)) {
      return errorResult(`Unresolved path parameters for "${operationId}".`, 'validation_error');
    }

    const query: Record<string, unknown> = {};
    for (const name of operation.queryParams) {
      if (name in remaining) {
        query[name] = remaining[name];
        delete remaining[name];
      }
    }

    const isBodyless = method === 'GET' || method === 'DELETE';
    if (isBodyless) {
      Object.assign(query, remaining);
      for (const key of Object.keys(remaining)) delete remaining[key];
    }

    const body = isBodyless ? undefined : remaining;
    const requestConfig = {
      headers: { Authorization: `Bearer ${secret}` },
      ...(Object.keys(query).length > 0 ? { params: query } : {}),
    };

    try {
      const response = await this.apiClient.requestWithResponse(method, url, body, undefined, requestConfig);
      reportToolCall({ httpStatus: response.status, downstreamRequestId: downstreamRequestId(response.headers) });
      return { content: [{ type: 'text', text: JSON.stringify(response.data) }] };
    } catch (error) {
      if (error instanceof ApiError && method !== 'GET' && (error.statusCode === undefined || error.statusCode >= 500)) {
        reportToolCall({ httpStatus: error.statusCode, downstreamRequestId: downstreamRequestId(error.headers) });
        const cause = error.statusCode === undefined ? `no response arrived (${error.message})` : `the API answered ${error.statusCode}`;
        return errorResult(unknownWriteOutcome(operationId, cause), errorCodeForUpstream(error));
      }
      if (error instanceof ApiError) {
        reportToolCall({ httpStatus: error.statusCode, downstreamRequestId: downstreamRequestId(error.headers) });
        return errorResult(
          JSON.stringify({ operationId, statusCode: error.statusCode, message: error.message, error: error.data }),
          errorCodeForUpstream(error),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`glomo API call failed for "${operationId}": ${message}`, 'internal');
    }
  }
}
