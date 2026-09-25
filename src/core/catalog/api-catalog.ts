import { OpenAPIV3 } from 'openapi-types';

import { THttpMethod } from '@/shared/api-client/api-client.module';
import { IParsedSpec, HTTP_METHODS, normalisePath } from '@/core/dispatcher/dispatcher.module';

export interface ICatalogParam {
  name: string;
  in: string;
  required: boolean;
  type?: string;
  description?: string;
  enum?: unknown[];
  example?: unknown;
}

export interface ICatalogResponse {
  status: string;
  description?: string;
  schema?: unknown;
}

export interface ICatalogEntry {
  operationId: string;
  method: THttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: ICatalogParam[];
  requestBody?: { required: boolean; contentType: string; schema: unknown };
  responses: ICatalogResponse[];
}

export interface IApiSearchResult {
  operationId: string;
  method: THttpMethod;
  path: string;
  summary: string;
  tags: string[];
  score: number;
}

export type TApiDetailsResult = ICatalogEntry | { operationId: string; error: string };

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'for',
  'in',
  'on',
  'at',
  'is',
  'are',
  'be',
  'with',
  'by',
  'as',
  'it',
  'this',
  'that',
  'from',
  'you',
  'your',
]);
const K1 = 1.5;
const B = 0.75;
const SCHEMA_MAX_DEPTH = 12;

function tokenize(text: string): string[] {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function sanitizeSchema(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return { $circular: true };
  if (depth >= SCHEMA_MAX_DEPTH) return { $truncated: true };

  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => sanitizeSchema(item, depth + 1, seen))
    : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, val]) => [key, sanitizeSchema(val, depth + 1, seen)]));
  seen.delete(value);
  return result;
}

function toParam(parameter: OpenAPIV3.ParameterObject): ICatalogParam {
  const schema = parameter.schema as OpenAPIV3.SchemaObject | undefined;
  return {
    name: parameter.name,
    in: parameter.in,
    required: Boolean(parameter.required),
    type: schema?.type,
    description: parameter.description,
    enum: schema?.enum,
    example: parameter.example ?? schema?.example,
  };
}

function toRequestBody(operation: OpenAPIV3.OperationObject): ICatalogEntry['requestBody'] {
  const body = operation.requestBody as OpenAPIV3.RequestBodyObject | undefined;
  const entry = Object.entries(body?.content ?? {})[0];
  if (!entry) return undefined;
  const [contentType, media] = entry;
  return { required: Boolean(body?.required), contentType, schema: sanitizeSchema(media.schema) };
}

function toResponses(operation: OpenAPIV3.OperationObject): ICatalogResponse[] {
  return Object.entries(operation.responses ?? {}).map(([status, value]) => {
    const response = value as OpenAPIV3.ResponseObject;
    const media = response.content?.['application/json'] ?? Object.values(response.content ?? {})[0];
    return { status, description: response.description, schema: media?.schema ? sanitizeSchema(media.schema) : undefined };
  });
}

export class ApiCatalog {
  private byId: Map<string, ICatalogEntry>;
  private termFreqs: Map<string, number>[];
  private docLengths: number[];
  private idf: Map<string, number>;
  private avgdl: number;

  constructor(
    private entries: ICatalogEntry[],
    private allSpecIds: ReadonlySet<string>,
  ) {
    this.byId = new Map(entries.map((entry) => [entry.operationId, entry]));

    const repeat = (tokens: string[], times: number): string[] => Array.from({ length: times }, () => tokens).flat();
    const docTokens = entries.map((entry) => [
      ...repeat(tokenize(entry.operationId), 3),
      ...repeat(tokenize(entry.summary), 3),
      ...repeat(tokenize(entry.tags.join(' ')), 2),
      ...tokenize(entry.path),
      ...tokenize(entry.description),
      ...tokenize(entry.parameters.map((param) => param.name).join(' ')),
    ]);
    this.docLengths = docTokens.map((tokens) => tokens.length);
    this.avgdl = this.docLengths.reduce((sum, len) => sum + len, 0) / (this.docLengths.length || 1) || 1;

    this.termFreqs = docTokens.map((tokens) => {
      const freq = new Map<string, number>();
      for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
      return freq;
    });

    const docFreq = new Map<string, number>();
    for (const freq of this.termFreqs) {
      for (const term of freq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    const total = entries.length || 1;
    this.idf = new Map();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
    }
  }

  get size(): number {
    return this.entries.length;
  }

  search(query: string, limit: number): IApiSearchResult[] {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return [];

    return this.entries
      .map((entry, i) => {
        let score = 0;
        for (const term of terms) {
          const freq = this.termFreqs[i].get(term);
          if (!freq) continue;
          const idf = this.idf.get(term) ?? 0;
          score += (idf * (freq * (K1 + 1))) / (freq + K1 * (1 - B + (B * this.docLengths[i]) / this.avgdl));
        }
        return { entry, score };
      })
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, score }) => ({
        operationId: entry.operationId,
        method: entry.method,
        path: entry.path,
        summary: entry.summary,
        tags: entry.tags,
        score: Number(score.toFixed(3)),
      }));
  }

  details(operationId: string): TApiDetailsResult {
    const entry = this.byId.get(operationId);
    if (entry) return entry;
    if (this.allSpecIds.has(operationId)) {
      return { operationId, error: `operationId "${operationId}" exists but is not on the discoverable Glomopay API surface.` };
    }
    return { operationId, error: `Unknown operationId "${operationId}": not a documented Glomopay operation.` };
  }
}

export function buildCatalog(parsed: IParsedSpec, allowedOperationIds: Iterable<string>): ApiCatalog {
  const { document, prefix, defaultVersion } = parsed;
  const allowed = new Set(allowedOperationIds);
  const allSpecIds = new Set<string>();
  const entries: ICatalogEntry[] = [];

  for (const [rawPath, pathItem] of Object.entries(document.paths ?? {})) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method.toLowerCase() as OpenAPIV3.HttpMethods];
      if (!operation || !operation.operationId) continue;

      allSpecIds.add(operation.operationId);
      if (!allowed.has(operation.operationId)) continue;

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])] as OpenAPIV3.ParameterObject[];
      entries.push({
        operationId: operation.operationId,
        method,
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

  return new ApiCatalog(entries, allSpecIds);
}
