import { ICatalogEntry, ICatalogParam } from '@/core/catalog/catalog.module';

export type TSampleLanguage = 'curl' | 'python' | 'node';

export interface ISampleField {
  name: string;
  value: string;
  isFile: boolean;
}

export interface ISampleRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  form?: ISampleField[];
}

const MAX_DEPTH = 8;
const REQUEST_ID_VALUE = 'req_0001';

type TSchema = Record<string, unknown>;

function asSchema(value: unknown): TSchema | undefined {
  return value && typeof value === 'object' ? (value as TSchema) : undefined;
}

function pickExample(source: { example?: unknown; examples?: unknown } | undefined): unknown {
  if (!source) return undefined;
  if (source.example !== undefined) return source.example;
  const first = source.examples && typeof source.examples === 'object' ? Object.values(source.examples as object)[0] : undefined;
  if (first && typeof first === 'object' && 'value' in first) return (first as { value: unknown }).value;
  return first;
}

function stringSample(schema: TSchema): string {
  switch (schema.format) {
    case 'email':
      return 'user@example.com';
    case 'date-time':
    case 'timestamp':
      return '2025-01-01T00:00:00Z';
    case 'date':
      return '2025-01-01';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'uri':
    case 'url':
      return 'https://example.com';
    default:
      return 'string';
  }
}

// The request shape of an object schema, resolving allOf (union of parts) and
// oneOf/anyOf (first branch). required stays explicit: a part that omits it
// contributes no required keys, so an allOf of a broad base and a constrained
// oneOf branch selects only the branch's fields.
function resolveObject(schema: TSchema, depth: number): { properties: Record<string, TSchema>; required: string[] } {
  const properties: Record<string, TSchema> = {};
  const required: string[] = [];

  const absorb = (part: TSchema | undefined) => {
    if (!part || depth > MAX_DEPTH) return;
    if (Array.isArray(part.allOf)) part.allOf.forEach((sub) => absorb(asSchema(sub)));
    const branch = Array.isArray(part.oneOf) ? part.oneOf[0] : Array.isArray(part.anyOf) ? part.anyOf[0] : undefined;
    if (branch) absorb(asSchema(branch));
    for (const [key, value] of Object.entries((part.properties as Record<string, unknown>) ?? {})) {
      const propSchema = asSchema(value);
      if (propSchema) properties[key] = { ...properties[key], ...propSchema };
    }
    if (Array.isArray(part.required)) required.push(...(part.required as string[]));
  };

  absorb(schema);
  return { properties, required };
}

function sampleObject(schema: TSchema, depth: number): Record<string, unknown> {
  const { properties, required } = resolveObject(schema, depth);
  const emit = required.length ? new Set(required) : new Set(Object.keys(properties));
  const out: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    if (propSchema.readOnly === true) continue;
    if (emit.has(key)) out[key] = sampleValue(propSchema, depth + 1);
  }
  return out;
}

function sampleValue(schema: unknown, depth = 0): unknown {
  const s = asSchema(schema);
  if (!s || depth > MAX_DEPTH) return null;

  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];

  if (Array.isArray(s.allOf)) return sampleObject(s, depth);
  if (Array.isArray(s.oneOf) && s.oneOf.length) return sampleValue(s.oneOf[0], depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return sampleValue(s.anyOf[0], depth + 1);

  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'object' || (!type && s.properties)) return sampleObject(s, depth);
  if (type === 'array') return [sampleValue(s.items ?? {}, depth + 1)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  return stringSample(s);
}

function paramValue(param: ICatalogParam): string {
  const fromParam = pickExample(param);
  if (fromParam !== undefined && fromParam !== null) return String(fromParam);
  const schema = asSchema(param.schema);
  if (schema?.example !== undefined && schema.example !== null) return String(schema.example);
  if (param.in === 'path') return `<${param.name}>`;
  const synthesised = sampleValue(schema);
  return synthesised === null ? `<${param.name}>` : String(synthesised);
}

function isMultipart(contentType: string): boolean {
  return /multipart|form-data|x-www-form-urlencoded/i.test(contentType);
}

function isBinary(schema: TSchema): boolean {
  return schema.format === 'binary' || schema.format === 'byte';
}

function buildForm(schema: unknown): ISampleField[] {
  const { properties, required } = resolveObject(asSchema(schema) ?? {}, 0);
  const emit = required.length ? new Set(required) : new Set(Object.keys(properties));
  const fields: ISampleField[] = [];
  for (const [name, propSchema] of Object.entries(properties)) {
    if (propSchema.readOnly === true || !emit.has(name)) continue;
    if (isBinary(propSchema)) fields.push({ name, value: `./${name}`, isFile: true });
    else fields.push({ name, value: String(sampleValue(propSchema) ?? ''), isFile: false });
  }
  return fields;
}

function withRequestId(body: unknown, schema: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const { properties } = resolveObject(asSchema(schema) ?? {}, 0);
  if (properties.request_id && !('request_id' in record)) return { request_id: REQUEST_ID_VALUE, ...record };
  return record;
}

export function buildSampleRequest(entry: ICatalogEntry, origin: string): ISampleRequest {
  let path = entry.path;
  for (const param of entry.parameters.filter((p) => p.in === 'path')) {
    path = path.replace(`{${param.name}}`, paramValue(param));
  }

  const query = entry.parameters
    .filter((param) => param.in === 'query' && (param.required || pickExample(param) !== undefined))
    .map((param) => `${encodeURIComponent(param.name)}=${encodeURIComponent(paramValue(param))}`);

  const url = `${origin}${path}${query.length ? `?${query.join('&')}` : ''}`;
  const headers: Record<string, string> = {};

  const request: ISampleRequest = { method: entry.method, url, headers };
  if (entry.requestBody) {
    if (isMultipart(entry.requestBody.contentType)) {
      request.form = buildForm(entry.requestBody.schema);
    } else {
      headers['Content-Type'] = entry.requestBody.contentType;
      const raw = pickExample(entry.requestBody) ?? sampleValue(entry.requestBody.schema);
      request.body = withRequestId(raw, entry.requestBody.schema);
    }
  }
  return request;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderCurl(request: ISampleRequest): string {
  const lines = [`curl -X ${request.method} ${shellQuote(request.url)}`, '  -H "Authorization: Bearer $GLOMO_API_KEY"'];
  for (const [key, value] of Object.entries(request.headers)) lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`);
  if (request.form) {
    for (const field of request.form) lines.push(`  -F ${shellQuote(`${field.name}=${field.isFile ? `@${field.value}` : field.value}`)}`);
  } else if (request.body !== undefined) {
    lines.push(`  -d ${shellQuote(JSON.stringify(request.body, null, 2))}`);
  }
  return lines.join(' \\\n');
}

function toPython(value: unknown, indent = 0): string {
  const pad = '    '.repeat(indent);
  const padInner = '    '.repeat(indent + 1);
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((item) => `${padInner}${toPython(item, indent + 1)}`).join(',\n')}\n${pad}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${padInner}${JSON.stringify(k)}: ${toPython(v, indent + 1)}`).join(',\n')}\n${pad}}`;
}

function pythonHeaders(request: ISampleRequest): string {
  const lines = [`    "Authorization": f"Bearer {os.environ['GLOMO_API_KEY']}"`];
  for (const [key, value] of Object.entries(request.headers)) lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(',\n')}\n}`;
}

function renderPython(request: ISampleRequest): string {
  const method = request.method.toLowerCase();
  const lines = ['import os', 'import requests', '', `url = ${JSON.stringify(request.url)}`, `headers = ${pythonHeaders(request)}`, ''];
  if (request.form) {
    const data = request.form.filter((f) => !f.isFile);
    const files = request.form.filter((f) => f.isFile);
    if (data.length) lines.push(`data = ${toPython(Object.fromEntries(data.map((f) => [f.name, f.value])))}`);
    if (files.length) lines.push(`files = {${files.map((f) => `${JSON.stringify(f.name)}: open(${JSON.stringify(f.value)}, "rb")`).join(', ')}}`);
    const parts = ['url', 'headers=headers', data.length ? 'data=data' : '', files.length ? 'files=files' : ''].filter(Boolean);
    lines.push('', `response = requests.${method}(${parts.join(', ')})`);
  } else if (request.body !== undefined) {
    lines.push(`payload = ${toPython(request.body)}`, '', `response = requests.${method}(url, headers=headers, json=payload)`);
  } else {
    lines.push(`response = requests.${method}(url, headers=headers)`);
  }
  lines.push('print(response.status_code, response.json())');
  return lines.join('\n');
}

function nodeHeaders(request: ISampleRequest, includeContentType: boolean): string {
  const lines = ['    Authorization: `Bearer ${process.env.GLOMO_API_KEY}`'];
  if (includeContentType)
    for (const [key, value] of Object.entries(request.headers)) lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(',\n')}\n  }`;
}

function renderNode(request: ISampleRequest): string {
  const lines: string[] = [];
  if (request.form) {
    lines.push('import { openAsBlob } from "node:fs";', '', 'const form = new FormData();');
    for (const field of request.form) {
      if (field.isFile) lines.push(`form.append(${JSON.stringify(field.name)}, await openAsBlob(${JSON.stringify(field.value)}));`);
      else lines.push(`form.append(${JSON.stringify(field.name)}, ${JSON.stringify(field.value)});`);
    }
    lines.push('');
  }

  const init = [`  method: ${JSON.stringify(request.method)}`, `  headers: ${nodeHeaders(request, request.body !== undefined)}`];
  if (request.form) init.push('  body: form');
  else if (request.body !== undefined) init.push(`  body: JSON.stringify(${JSON.stringify(request.body, null, 2).replace(/\n/g, '\n  ')})`);

  lines.push(
    `const response = await fetch(${JSON.stringify(request.url)}, {`,
    init.join(',\n'),
    '});',
    'const data = await response.json();',
    'console.log(response.status, data);',
  );
  return lines.join('\n');
}

const RENDERERS: Record<TSampleLanguage, (request: ISampleRequest) => string> = {
  curl: renderCurl,
  python: renderPython,
  node: renderNode,
};

export function renderSample(request: ISampleRequest, language: TSampleLanguage): string {
  return RENDERERS[language](request);
}
