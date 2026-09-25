import { OpenAPIV3 } from 'openapi-types';

import { THttpMethod } from '@/shared/api-client/api-client.module';
import { Bm25Index, STOPWORDS, repeat } from '@/shared/search/search.module';
import { IParsedSpec, HTTP_METHODS, normalisePath } from '@/core/dispatcher/dispatcher.module';

export const EXECUTION_TOOLS = { read: 'glomo_api_read', write: 'glomo_api_write' } as const;
export type TExecutionTool = (typeof EXECUTION_TOOLS)[keyof typeof EXECUTION_TOOLS];

export interface ICatalogParam {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: unknown;
  example?: unknown;
  examples?: unknown;
}

export interface ICatalogBody {
  required: boolean;
  contentType: string;
  schema?: unknown;
  example?: unknown;
  examples?: unknown;
}

export interface ICatalogResponse {
  status: string;
  description?: string;
  schema?: unknown;
  example?: unknown;
  examples?: unknown;
}

export interface ICatalogEntry {
  operationId: string;
  method: THttpMethod;
  executable: boolean;
  tool?: TExecutionTool;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: ICatalogParam[];
  requestBody?: ICatalogBody;
  responses: ICatalogResponse[];
}

export interface IApiSearchResult {
  operationId: string;
  method: THttpMethod;
  executable: boolean;
  tool?: TExecutionTool;
  path: string;
  summary: string;
  tags: string[];
  score: number;
}

export type TApiDetailsResult = ICatalogEntry | { operationId: string; error: string };

function tokenize(text: string): string[] {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function toolFor(method: THttpMethod): TExecutionTool {
  return method === 'GET' ? EXECUTION_TOOLS.read : EXECUTION_TOOLS.write;
}

function sanitizeSchema(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return { $circular: true };

  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => sanitizeSchema(item, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !key.startsWith('x-'))
          .map(([key, val]) => [key, sanitizeSchema(val, seen)]),
      );
  seen.delete(value);
  return result;
}

function toParam(parameter: OpenAPIV3.ParameterObject): ICatalogParam {
  return {
    name: parameter.name,
    in: parameter.in,
    required: Boolean(parameter.required),
    description: parameter.description,
    schema: parameter.schema ? sanitizeSchema(parameter.schema) : undefined,
    example: parameter.example,
    examples: parameter.examples ? sanitizeSchema(parameter.examples) : undefined,
  };
}

function toRequestBody(operation: OpenAPIV3.OperationObject): ICatalogBody | undefined {
  const body = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  const entry = Object.entries(body?.content ?? {})[0];
  if (!entry) return undefined;
  const [contentType, media] = entry;
  return {
    required: Boolean(body?.required),
    contentType,
    schema: media.schema ? sanitizeSchema(media.schema) : undefined,
    example: media.example,
    examples: media.examples ? sanitizeSchema(media.examples) : undefined,
  };
}

function toResponses(operation: OpenAPIV3.OperationObject): ICatalogResponse[] {
  return Object.entries(operation.responses ?? {}).map(([status, value]) => {
    const response = value as OpenAPIV3.ResponseObject;
    const media = response.content?.['application/json'] ?? Object.values(response.content ?? {})[0];
    return {
      status,
      description: response.description,
      schema: media?.schema ? sanitizeSchema(media.schema) : undefined,
      example: media?.example,
      examples: media?.examples ? sanitizeSchema(media.examples) : undefined,
    };
  });
}

function bodyPropertyNames(entry: ICatalogEntry): string[] {
  const schema = entry.requestBody?.schema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties ? Object.keys(schema.properties) : [];
}

export class ApiCatalog {
  private byId: Map<string, ICatalogEntry>;
  private bm25: Bm25Index;

  constructor(
    private entries: ICatalogEntry[],
    readonly origin: string = '',
  ) {
    this.byId = new Map(entries.map((entry) => [entry.operationId, entry]));

    this.bm25 = new Bm25Index(
      entries.map((entry) => [
        ...repeat(tokenize(entry.operationId), 3),
        ...repeat(tokenize(entry.summary), 3),
        ...repeat(tokenize(entry.tags.join(' ')), 2),
        ...tokenize(entry.path),
        ...tokenize(entry.description),
        ...tokenize(entry.parameters.map((param) => param.name).join(' ')),
        ...tokenize(bodyPropertyNames(entry).join(' ')),
      ]),
    );
  }

  get size(): number {
    return this.entries.length;
  }

  search(query: string, limit: number): IApiSearchResult[] {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return [];

    const scores = this.bm25.scores(terms);
    return this.entries
      .map((entry, i) => ({ entry, score: scores[i] }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, score }) => ({
        operationId: entry.operationId,
        method: entry.method,
        executable: entry.executable,
        tool: entry.tool,
        path: entry.path,
        summary: entry.summary,
        tags: entry.tags,
        score: Number(score.toFixed(3)),
      }));
  }

  details(operationId: string): TApiDetailsResult {
    return (
      this.byId.get(operationId) ?? {
        operationId,
        error: `Unknown operationId "${operationId}": not a documented glomo operation.`,
      }
    );
  }
}

function serverOrigin(document: OpenAPIV3.Document): string {
  const serverUrl = document.servers?.[0]?.url;
  if (!serverUrl) return '';
  try {
    return new URL(serverUrl).origin;
  } catch {
    return '';
  }
}

export function buildCatalog(parsed: IParsedSpec, allowedOperationIds: Iterable<string>): ApiCatalog {
  const { document, prefix, defaultVersion } = parsed;
  const allowed = new Set(allowedOperationIds);
  const entries: ICatalogEntry[] = [];

  for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method.toLowerCase() as OpenAPIV3.HttpMethods];
      if (!operation || !operation.operationId) continue;

      const executable = allowed.has(operation.operationId);
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])] as OpenAPIV3.ParameterObject[];
      entries.push({
        operationId: operation.operationId,
        method,
        executable,
        tool: executable ? toolFor(method) : undefined,
        path: normalisePath(rawPath, prefix, defaultVersion),
        summary: operation.summary ?? '',
        description: operation.description ?? '',
        tags: operation.tags ?? [],
        parameters: parameters.map(toParam),
        requestBody: toRequestBody(operation),
        responses: toResponses(operation),
      });
    }
  }

  return new ApiCatalog(entries, serverOrigin(document));
}
