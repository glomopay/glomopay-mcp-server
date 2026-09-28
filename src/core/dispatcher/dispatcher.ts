import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { TToolExtra } from '@/shared/tool/tool.module';
import { ApiClient, ApiError, THttpMethod } from '@/shared/api-client/api-client.module';
import { CredentialVerifier } from '@/features/auth/auth.module';

import { TSpecIndex } from './spec-index';

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
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
      return errorResult(`Unknown operationId "${operationId}": not a documented glomo operation.`);
    }

    if (!this.allowlist.has(operationId)) {
      return errorResult(`operationId "${operationId}" is not on the execution allowlist and cannot be called.`);
    }

    if (!allowedMethods.includes(operation.method)) {
      return errorResult(
        `operationId "${operationId}" is a ${operation.method} operation; this tool only serves ${allowedMethods.join('/')}. ` +
          `Use ${operation.method === 'GET' ? 'glomo_api_read' : 'glomo_api_write'} instead.`,
      );
    }

    const credential = await this.verifier.resolve(extra);
    if (credential.status === 'absent') {
      return errorResult('Unauthorized: no glomo credential supplied for this request.');
    }
    if (credential.status === 'invalid') {
      return errorResult(`Unauthorized: ${credential.reason}.`);
    }

    const { token: secret, env } = credential.credential;
    const isWrite = operation.method !== 'GET';

    if (isWrite && env !== 'sandbox') {
      return errorResult(`Refusing "${operationId}": the write tools are sandbox-only and require a sandbox credential.`);
    }

    // Route from the raw params; the glomo API validates the body. A derived
    // schema would under-model some request bodies and silently drop valid fields.
    const { method } = operation;
    const remaining: Record<string, unknown> = { ...(params ?? {}) };

    for (const name of operation.pathParams) {
      const value = remaining[name];
      if (typeof value !== 'string' || value.trim() === '') {
        return errorResult(`Missing or invalid path parameter "${name}" for "${operationId}": expected a non-empty string.`);
      }
      if (value === '.' || value === '..' || value.includes('/')) {
        return errorResult(`Invalid path parameter "${name}" for "${operationId}": must be a single safe path segment.`);
      }
    }

    const url = operation.path.replace(/\{([^}]+)\}/g, (match, key) => {
      if (!(key in remaining)) return match;
      const value = String(remaining[key]);
      delete remaining[key];
      return encodeURIComponent(value);
    });

    if (/\{[^}]+\}/.test(url)) {
      return errorResult(`Unresolved path parameters for "${operationId}".`);
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
      const response = await this.apiClient.request(method, url, body, undefined, requestConfig);
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch (error) {
      if (error instanceof ApiError) {
        return errorResult(JSON.stringify({ operationId, statusCode: error.statusCode, message: error.message, error: error.data }));
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`glomo API call failed for "${operationId}": ${message}`);
    }
  }
}
