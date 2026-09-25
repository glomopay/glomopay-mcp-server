import { ICatalogEntry, ICatalogParam } from '@/core/catalog/catalog.module';

export type TSampleLanguage = 'curl' | 'python' | 'node';

export interface ISampleRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

const CREDENTIAL_PLACEHOLDER = 'Bearer $GLOMO_API_KEY';
const MAX_DEPTH = 8;

type TSchema = Record<string, unknown>;

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

function sampleValue(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) return null;
  const s = schema as TSchema;

  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];

  if (Array.isArray(s.allOf)) {
    return s.allOf.reduce<Record<string, unknown>>((acc, part) => {
      const value = sampleValue(part, depth + 1);
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...acc, ...value } : acc;
    }, {});
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length) return sampleValue(s.oneOf[0], depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return sampleValue(s.anyOf[0], depth + 1);

  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'object' || (!type && s.properties)) {
    const properties = (s.properties as Record<string, unknown>) ?? {};
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : Object.keys(properties));
    const out: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (required.has(key)) out[key] = sampleValue(propSchema, depth + 1);
    }
    return out;
  }
  if (type === 'array') return [sampleValue(s.items ?? {}, depth + 1)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  return stringSample(s);
}

function paramValue(param: ICatalogParam): string {
  const example = pickExample(param);
  if (example !== undefined && example !== null) return String(example);
  if (param.in === 'path') return `<${param.name}>`;
  const synthesised = sampleValue(param.schema);
  return synthesised === null ? `<${param.name}>` : String(synthesised);
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
  const headers: Record<string, string> = { Authorization: CREDENTIAL_PLACEHOLDER };

  let body: unknown;
  if (entry.requestBody) {
    headers['Content-Type'] = entry.requestBody.contentType;
    body = pickExample(entry.requestBody) ?? sampleValue(entry.requestBody.schema);
  }

  return { method: entry.method, url, headers, body };
}

function renderCurl(request: ISampleRequest): string {
  const lines = [`curl -X ${request.method} '${request.url}'`];
  for (const [key, value] of Object.entries(request.headers)) lines.push(`  -H '${key}: ${value}'`);
  if (request.body !== undefined) lines.push(`  -d '${JSON.stringify(request.body, null, 2)}'`);
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

function renderPython(request: ISampleRequest): string {
  const lines = ['import requests', '', `url = ${JSON.stringify(request.url)}`, `headers = ${toPython(request.headers, 0)}`];
  if (request.body !== undefined) {
    lines.push(`payload = ${toPython(request.body, 0)}`);
    lines.push('', `response = requests.${request.method.toLowerCase()}(url, headers=headers, json=payload)`);
  } else {
    lines.push('', `response = requests.${request.method.toLowerCase()}(url, headers=headers)`);
  }
  lines.push('print(response.status_code, response.json())');
  return lines.join('\n');
}

function renderNode(request: ISampleRequest): string {
  const init: string[] = [
    `  method: ${JSON.stringify(request.method)}`,
    `  headers: ${JSON.stringify(request.headers, null, 2).replace(/\n/g, '\n  ')}`,
  ];
  if (request.body !== undefined) init.push(`  body: JSON.stringify(${JSON.stringify(request.body, null, 2).replace(/\n/g, '\n  ')})`);
  return [
    `const response = await fetch(${JSON.stringify(request.url)}, {`,
    init.join(',\n'),
    '});',
    'const data = await response.json();',
    'console.log(response.status, data);',
  ].join('\n');
}

const RENDERERS: Record<TSampleLanguage, (request: ISampleRequest) => string> = {
  curl: renderCurl,
  python: renderPython,
  node: renderNode,
};

export function renderSample(request: ISampleRequest, language: TSampleLanguage): string {
  return RENDERERS[language](request);
}
