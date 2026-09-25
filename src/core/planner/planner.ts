import { THttpMethod } from '@/shared/api-client/api-client.module';
import { ApiCatalog, ICatalogEntry, TExecutionTool } from '@/core/catalog/catalog.module';
import { DocsIndex } from '@/core/docs/docs.module';

export interface IPlanStep {
  step: number;
  operationId: string;
  method: THttpMethod;
  executable: boolean;
  tool?: TExecutionTool;
  path: string;
  summary: string;
  dependsOn: string[];
}

export interface IPlanDoc {
  title: string;
  url: string;
  anchor: string;
}

export interface IPlan {
  goal: string;
  steps: IPlanStep[];
  docs: IPlanDoc[];
}

export interface IPlanOptions {
  catalog: ApiCatalog;
  docsIndex?: DocsIndex;
  goal: string;
  limit?: number;
}

const DEFAULT_LIMIT = 8;
const DOC_LIMIT = 5;
const MAX_DEPTH = 8;

type TSchema = Record<string, unknown>;

function asSchema(value: unknown): TSchema | undefined {
  return value && typeof value === 'object' ? (value as TSchema) : undefined;
}

function resourceOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const versionAt = segments.findIndex((segment) => /^v\d+$/.test(segment));
  const rest = versionAt >= 0 ? segments.slice(versionAt + 1) : segments.filter((segment) => segment !== 'api');
  return rest.find((segment) => !segment.startsWith('{')) ?? '';
}

function singular(resource: string): string {
  return resource.endsWith('s') ? resource.slice(0, -1) : resource;
}

function tokenFor(name: string, resource: string): string {
  if (name === 'id') return singular(resource);
  return singular(name.replace(/_id$/, ''));
}

function requiredProps(schema: unknown, depth = 0): string[] {
  const s = asSchema(schema);
  if (!s || depth > MAX_DEPTH) return [];
  if (Array.isArray(s.allOf)) return s.allOf.flatMap((part) => requiredProps(part, depth + 1));
  if (Array.isArray(s.oneOf) && s.oneOf.length) return requiredProps(s.oneOf[0], depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return requiredProps(s.anyOf[0], depth + 1);
  return Array.isArray(s.required) ? (s.required as string[]) : [];
}

function hasPathParam(entry: ICatalogEntry): boolean {
  return entry.parameters.some((param) => param.in === 'path');
}

function producedResource(entry: ICatalogEntry): string | undefined {
  if (entry.method !== 'POST' || hasPathParam(entry)) return undefined;
  const resource = resourceOf(entry.path);
  return resource ? singular(resource) : undefined;
}

function consumedResources(entry: ICatalogEntry): Set<string> {
  const resource = resourceOf(entry.path);
  const tokens = new Set<string>();

  if (hasPathParam(entry) && resource) tokens.add(singular(resource));

  const idParamNames = entry.parameters
    .filter((param) => (param.in === 'path' || (param.in === 'query' && param.required)) && /(^id$)|_id$/.test(param.name))
    .map((param) => param.name);
  const idBodyNames = requiredProps(entry.requestBody?.schema).filter((name) => /(^id$)|_id$/.test(name));

  for (const name of [...idParamNames, ...idBodyNames]) {
    const token = tokenFor(name, resource);
    if (token) tokens.add(token);
  }
  return tokens;
}

function verbRank(entry: ICatalogEntry): number {
  if (entry.method === 'POST') return hasPathParam(entry) ? 1 : 0;
  if (entry.method === 'GET') return 2;
  if (entry.method === 'DELETE') return 4;
  return 3;
}

export function planIntegration({ catalog, docsIndex, goal, limit }: IPlanOptions): IPlan {
  const hits = catalog.search(goal, limit ?? DEFAULT_LIMIT);
  const docs = docsIndex ? docsIndex.search(goal, DOC_LIMIT).map((doc) => ({ title: doc.title, url: doc.url, anchor: doc.anchor })) : [];

  const entries = hits.map((hit) => catalog.details(hit.operationId)).filter((entry): entry is ICatalogEntry => !('error' in entry));
  if (entries.length === 0) return { goal, steps: [], docs };

  const rank = new Map(entries.map((entry, index) => [entry.operationId, index]));
  const producers = new Map<string, string>();
  for (const entry of entries) {
    const produced = producedResource(entry);
    if (produced && !producers.has(produced)) producers.set(produced, entry.operationId);
  }

  const dependsOn = new Map<string, Set<string>>(entries.map((entry) => [entry.operationId, new Set()]));
  for (const entry of entries) {
    for (const token of consumedResources(entry)) {
      const producer = producers.get(token);
      if (producer && producer !== entry.operationId) dependsOn.get(entry.operationId)!.add(producer);
    }
  }

  const byId = new Map(entries.map((entry) => [entry.operationId, entry]));
  const indegree = new Map(entries.map((entry) => [entry.operationId, dependsOn.get(entry.operationId)!.size]));
  const dependents = new Map<string, string[]>(entries.map((entry) => [entry.operationId, []]));
  for (const entry of entries) {
    for (const dep of dependsOn.get(entry.operationId)!) dependents.get(dep)!.push(entry.operationId);
  }

  const order = (a: string, b: string): number => verbRank(byId.get(a)!) - verbRank(byId.get(b)!) || rank.get(a)! - rank.get(b)!;

  const ordered: string[] = [];
  const remaining = new Set(entries.map((entry) => entry.operationId));
  while (remaining.size) {
    const ready = [...remaining].filter((id) => (indegree.get(id) ?? 0) === 0);
    const next = (ready.length ? ready : [...remaining]).sort(order)[0];
    ordered.push(next);
    remaining.delete(next);
    for (const dependent of dependents.get(next) ?? []) indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
  }

  const steps: IPlanStep[] = ordered.map((operationId, index) => {
    const entry = byId.get(operationId)!;
    return {
      step: index + 1,
      operationId,
      method: entry.method,
      executable: entry.executable,
      tool: entry.tool,
      path: entry.path,
      summary: entry.summary,
      dependsOn: [...dependsOn.get(operationId)!],
    };
  });

  return { goal, steps, docs };
}
