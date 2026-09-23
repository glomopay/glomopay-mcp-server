import { CallToolResult } from '@modelcontextprotocol/sdk/types';

import { TToolExtra } from '@/shared/tool/tool.module';
import { ApiClient, THttpMethod } from '@/shared/api-client/api-client.module';
import { resolveCredential } from '@/features/auth/auth.module';

import { TSpecIndex } from './spec-index';

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export class Dispatcher {
  constructor(
    private specIndex: TSpecIndex,
    private allowlist: ReadonlySet<string>,
    private apiClient: ApiClient,
  ) {}

  async dispatch(
    operationId: string,
    params: Record<string, unknown> | undefined,
    extra: TToolExtra,
    allowedMethods: readonly THttpMethod[],
  ): Promise<CallToolResult> {
    const operation = this.specIndex.get(operationId);
    if (!operation) {
      return errorResult(`Unknown operationId "${operationId}". Use the Glomopay API discovery tools to find a valid operation.`);
    }

    if (!this.allowlist.has(operationId)) {
      return errorResult(`operationId "${operationId}" is not on the execution allowlist and cannot be called.`);
    }

    if (!allowedMethods.includes(operation.method)) {
      return errorResult(
        `operationId "${operationId}" is a ${operation.method} operation; this tool only serves ${allowedMethods.join('/')}. ` +
          `Use ${operation.method === 'GET' ? 'glomopay_api_read' : 'glomopay_api_write'} instead.`,
      );
    }

    const secret = resolveCredential(extra);
    if (!secret) {
      return errorResult('Unauthorized: no Glomopay API secret supplied for this request.');
    }

    // Route from the raw params; the Glomopay API validates the body. A derived
    // (openapi2zod) schema under-models some request bodies, so validating and
    // routing from the parsed result would silently drop valid fields.
    const { method } = operation;
    const remaining: Record<string, unknown> = { ...(params ?? {}) };

    const url = operation.path.replace(/\{([^}]+)\}/g, (match, key) => {
      if (key in remaining) {
        const value = String(remaining[key]);
        delete remaining[key];
        return encodeURIComponent(value);
      }
      return match;
    });

    const query: Record<string, unknown> = {};
    for (const name of operation.queryParams) {
      if (name in remaining) {
        query[name] = remaining[name];
        delete remaining[name];
      }
    }

    // GET/DELETE have no body, so any remainder belongs in the query string.
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
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Glomopay API call failed for "${operationId}": ${message}`);
    }
  }
}
